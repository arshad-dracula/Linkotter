// Package app is the Linkotter desktop backend: it talks to the network engine over its
// local API and serves the interface (and a small JSON API for it) on a loopback port.
package app

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// Config is everything the shell decides before starting the backend.
type Config struct {
	Socket        string // engine socket; empty = platform default
	DefaultServer string // control server offered on the sign-in screen
	Token         string // required on every API call
	DataDir       string // history and settings
	DownloadDir   string // where received files are saved
	Version       string
	UI            fs.FS
	Autostart     Autostart // nil when the platform has no start-at-login support
	OpenPath      func(path string) error
	OpenURL       func(url string) error
}

// Autostart toggles "start when I sign in to this computer".
type Autostart interface {
	Enabled() bool
	Set(on bool) error
}

type App struct {
	cfg  Config
	lc   *local.Client
	drop *dropStore

	mu       sync.Mutex
	quality  map[tailcfg.StableNodeID]quality // last measured path per device
	lastSeen time.Time                        // last time the interface asked for state
	regions  map[string]string                // relay region code -> name

	subMu sync.Mutex
	subs  map[chan string]struct{}
}

type quality struct {
	LatencyMs float64
	Kind      string // direct, relay, peer-relay
	Via       string
	At        time.Time
}

func New(cfg Config) (*App, error) {
	if cfg.Token == "" {
		return nil, errors.New("token required")
	}
	ds, err := newDropStore(cfg.DataDir, cfg.DownloadDir)
	if err != nil {
		return nil, err
	}
	return &App{
		cfg:     cfg,
		lc:      &local.Client{Socket: cfg.Socket, UseSocketOnly: cfg.Socket != ""},
		drop:    ds,
		quality: map[tailcfg.StableNodeID]quality{},
		regions: map[string]string{},
		subs:    map[chan string]struct{}{},
	}, nil
}

// Run starts the background loops and blocks until ctx is done.
func (a *App) Run(ctx context.Context) {
	go a.watchEngine(ctx)
	go a.receiveLoop(ctx)
	go a.measureLoop(ctx)
	<-ctx.Done()
}

// ---- events -------------------------------------------------------------------------

func (a *App) publish(ev string) {
	a.subMu.Lock()
	defer a.subMu.Unlock()
	for ch := range a.subs {
		select {
		case ch <- ev:
		default: // slow listener; it also polls
		}
	}
}

func (a *App) watchEngine(ctx context.Context) {
	for ctx.Err() == nil {
		w, err := a.lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
		if err != nil {
			a.publish("state")
			sleep(ctx, 2*time.Second)
			continue
		}
		for {
			if _, err := w.Next(); err != nil {
				break
			}
			a.publish("state")
		}
		w.Close()
		a.publish("state")
		sleep(ctx, time.Second)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ---- state --------------------------------------------------------------------------

type Path struct {
	Kind      string   `json:"kind"` // direct, relay, peer-relay, idle
	Via       string   `json:"via,omitempty"`
	LatencyMs *float64 `json:"latencyMs,omitempty"`
}

type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DNSName    string `json:"dnsName"`
	OS         string `json:"os"`
	IP         string `json:"ip"`
	Online     bool   `json:"online"`
	LastSeen   string `json:"lastSeen,omitempty"`
	Mine       bool   `json:"mine"`
	Shared     bool   `json:"shared"` // tagged, e.g. an office NAS
	CanDrop    bool   `json:"canDrop"`
	ExitOption bool   `json:"exitOption"`
	Path       Path   `json:"path"`
}

type State struct {
	EngineOK    bool     `json:"engineOk"`
	EngineError string   `json:"engineError,omitempty"`
	State       string   `json:"state"`
	AuthURL     string   `json:"authUrl,omitempty"`
	Version     string   `json:"version"`
	Engine      string   `json:"engineVersion,omitempty"`
	Server      string   `json:"server"`
	Network     string   `json:"network,omitempty"`
	User        string   `json:"user,omitempty"`
	Self        *Device  `json:"self,omitempty"`
	Devices     []Device `json:"devices"`
	ExitNode    string   `json:"exitNode"`
	AcceptRoute bool     `json:"acceptRoutes"`
	UseDNS      bool     `json:"useDns"`
	Background  bool     `json:"background"`
	Autostart   *bool    `json:"autostart,omitempty"`
	Health      []string `json:"health,omitempty"`
	DownloadDir string   `json:"downloadDir"`
}

func shortName(ps *ipnstate.PeerStatus) string {
	if n, _, ok := strings.Cut(ps.DNSName, "."); ok && n != "" {
		return n
	}
	return ps.HostName
}

func (a *App) device(ps *ipnstate.PeerStatus, self *ipnstate.PeerStatus, canDrop map[tailcfg.StableNodeID]bool) Device {
	d := Device{
		ID:         string(ps.ID),
		Name:       shortName(ps),
		DNSName:    strings.TrimSuffix(ps.DNSName, "."),
		OS:         ps.OS,
		Online:     ps.Online,
		Shared:     ps.Tags != nil && ps.Tags.Len() > 0,
		ExitOption: ps.ExitNodeOption,
		CanDrop:    canDrop[ps.ID],
		Path:       Path{Kind: "idle"},
	}
	d.Mine = !d.Shared && self != nil && ps.UserID == self.UserID
	if len(ps.TailscaleIPs) > 0 {
		d.IP = ps.TailscaleIPs[0].String()
	}
	if !ps.Online && !ps.LastSeen.IsZero() {
		d.LastSeen = ps.LastSeen.UTC().Format(time.RFC3339)
	}
	switch {
	case ps.CurAddr != "":
		d.Path = Path{Kind: "direct"}
	case ps.PeerRelay != "":
		d.Path = Path{Kind: "peer-relay"}
	case ps.Relay != "" && ps.Active:
		d.Path = Path{Kind: "relay", Via: a.regionName(ps.Relay)}
	}
	a.mu.Lock()
	q, ok := a.quality[ps.ID]
	a.mu.Unlock()
	if ok && time.Since(q.At) < 2*time.Minute && ps.Online {
		ms := q.LatencyMs
		d.Path = Path{Kind: q.Kind, Via: q.Via, LatencyMs: &ms}
	}
	return d
}

func (a *App) regionName(code string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if n := a.regions[code]; n != "" {
		return n
	}
	return code
}

func (a *App) State(ctx context.Context) State {
	a.mu.Lock()
	a.lastSeen = time.Now()
	a.mu.Unlock()

	s := State{Version: a.cfg.Version, Server: a.cfg.DefaultServer, Devices: []Device{}, DownloadDir: a.drop.dir, State: "NoState"}
	if a.cfg.Autostart != nil {
		on := a.cfg.Autostart.Enabled()
		s.Autostart = &on
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := a.lc.Status(ctx)
	if err != nil {
		s.EngineError = "The Linkotter service is not running on this computer."
		return s
	}
	s.EngineOK = true
	s.State = st.BackendState
	s.AuthURL = st.AuthURL
	s.Engine = st.Version
	s.Health = st.Health
	if st.CurrentTailnet != nil {
		s.Network = st.CurrentTailnet.Name
	}
	if p, err := a.lc.GetPrefs(ctx); err == nil {
		if p.ControlURL != "" && p.ControlURL != ipn.DefaultControlURL {
			s.Server = p.ControlURL
		}
		s.ExitNode = string(p.ExitNodeID)
		s.AcceptRoute = p.RouteAll
		s.UseDNS = p.CorpDNS
		s.Background = p.ForceDaemon
	}
	if st.BackendState != "Running" && st.BackendState != "Starting" {
		return s
	}
	canDrop := map[tailcfg.StableNodeID]bool{}
	if fts, err := a.lc.FileTargets(ctx); err == nil {
		for _, ft := range fts {
			canDrop[ft.Node.StableID] = true
		}
	}
	if st.Self != nil {
		self := a.device(st.Self, st.Self, nil)
		self.Online = true
		self.Path = Path{Kind: "self"}
		s.Self = &self
		if u, ok := st.User[st.Self.UserID]; ok {
			s.User = u.DisplayName
			if s.User == "" {
				s.User = u.LoginName
			}
		}
	}
	for _, ps := range st.Peer {
		s.Devices = append(s.Devices, a.device(ps, st.Self, canDrop))
	}
	sort.Slice(s.Devices, func(i, j int) bool {
		x, y := s.Devices[i], s.Devices[j]
		if x.Online != y.Online {
			return x.Online
		}
		return strings.ToLower(x.Name) < strings.ToLower(y.Name)
	})
	return s
}

// ---- connection quality -------------------------------------------------------------

func (a *App) measure(ctx context.Context, id tailcfg.StableNodeID, ip netip.Addr) (quality, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	pr, err := a.lc.Ping(ctx, ip, tailcfg.PingDisco)
	if err != nil {
		return quality{}, err
	}
	if pr.Err != "" {
		return quality{}, errors.New(pr.Err)
	}
	q := quality{LatencyMs: pr.LatencySeconds * 1000, At: time.Now()}
	switch {
	case pr.PeerRelay != "":
		q.Kind = "peer-relay"
	case pr.Endpoint != "":
		q.Kind = "direct"
	default:
		q.Kind, q.Via = "relay", a.regionName(pr.DERPRegionCode)
	}
	a.mu.Lock()
	a.quality[id] = q
	a.mu.Unlock()
	return q, nil
}

// measureLoop keeps path and latency fresh for online devices, but only while the
// interface is actually open, so a closed window costs no traffic or battery.
func (a *App) measureLoop(ctx context.Context) {
	for ctx.Err() == nil {
		sleep(ctx, 20*time.Second)
		a.mu.Lock()
		watching := time.Since(a.lastSeen) < 45*time.Second
		a.mu.Unlock()
		if !watching {
			continue
		}
		sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		st, err := a.lc.Status(sctx)
		var dm *tailcfg.DERPMap
		if err == nil {
			dm, _ = a.lc.CurrentDERPMap(sctx)
		}
		cancel()
		if err != nil || st.BackendState != "Running" {
			continue
		}
		if dm != nil {
			a.mu.Lock()
			for _, r := range dm.Regions {
				a.regions[r.RegionCode] = r.RegionName
			}
			a.mu.Unlock()
		}
		sem := make(chan struct{}, 4)
		var wg sync.WaitGroup
		n := 0
		for _, ps := range st.Peer {
			if !ps.Online || len(ps.TailscaleIPs) == 0 || n >= 40 {
				continue
			}
			n++
			wg.Add(1)
			go func(id tailcfg.StableNodeID, ip netip.Addr) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				a.measure(ctx, id, ip)
			}(ps.ID, ps.TailscaleIPs[0])
		}
		wg.Wait()
		if n > 0 {
			a.publish("state")
		}
	}
}

// ---- actions ------------------------------------------------------------------------

type loginReq struct {
	Server  string `json:"server"`
	AuthKey string `json:"authKey"`
}

func normalizeServer(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("Enter your Linkotter server address.")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("That server address is not valid. It should look like https://link.example.com")
	}
	return u.Scheme + "://" + u.Host, nil
}

func (a *App) Login(ctx context.Context, r loginReq) error {
	server, err := normalizeServer(r.Server)
	if err != nil {
		return err
	}
	prefs, err := a.lc.GetPrefs(ctx)
	if err != nil {
		return err
	}
	st, err := a.lc.StatusWithoutPeers(ctx)
	if err != nil {
		return err
	}
	// Moving to a different server means the old identity no longer applies.
	if st.BackendState != "NeedsLogin" && st.BackendState != "NoState" && prefs.ControlURL != server {
		if err := a.lc.Logout(ctx); err != nil {
			return err
		}
		if prefs, err = a.lc.GetPrefs(ctx); err != nil {
			return err
		}
	}
	fresh := prefs.ControlURL != server
	prefs.ControlURL = server
	prefs.WantRunning = true
	prefs.LoggedOut = false
	if fresh {
		// Defaults chosen so Linkotter never disturbs the rest of the computer's networking:
		// only private names resolve through it, no traffic is rerouted.
		prefs.CorpDNS = true
		prefs.RouteAll = false
		prefs.ExitNodeID = ""
		prefs.ExitNodeIP = netip.Addr{}
		// Windows: stay connected when the window is closed or nobody is signed in.
		prefs.ForceDaemon = runtime.GOOS == "windows"
		if h, err := os.Hostname(); err == nil {
			prefs.Hostname = strings.ToLower(strings.Split(h, ".")[0])
		}
	}
	if err := a.lc.Start(ctx, ipn.Options{AuthKey: strings.TrimSpace(r.AuthKey), UpdatePrefs: prefs}); err != nil {
		return err
	}
	return a.lc.StartLoginInteractive(ctx)
}

func (a *App) setRunning(ctx context.Context, on bool) error {
	_, err := a.lc.EditPrefs(ctx, &ipn.MaskedPrefs{Prefs: ipn.Prefs{WantRunning: on}, WantRunningSet: true})
	return err
}

type prefsReq struct {
	AcceptRoutes *bool   `json:"acceptRoutes"`
	UseDNS       *bool   `json:"useDns"`
	Background   *bool   `json:"background"`
	ExitNode     *string `json:"exitNode"`
	Autostart    *bool   `json:"autostart"`
}

func (a *App) setPrefs(ctx context.Context, r prefsReq) error {
	mp := &ipn.MaskedPrefs{}
	changed := false
	if r.AcceptRoutes != nil {
		mp.RouteAll, mp.RouteAllSet, changed = *r.AcceptRoutes, true, true
	}
	if r.UseDNS != nil {
		mp.CorpDNS, mp.CorpDNSSet, changed = *r.UseDNS, true, true
	}
	if r.Background != nil {
		mp.ForceDaemon, mp.ForceDaemonSet, changed = *r.Background, true, true
	}
	if r.ExitNode != nil {
		mp.ExitNodeID, mp.ExitNodeIDSet = tailcfg.StableNodeID(*r.ExitNode), true
		mp.ExitNodeIP, mp.ExitNodeIPSet = netip.Addr{}, true
		changed = true
	}
	if changed {
		if _, err := a.lc.EditPrefs(ctx, mp); err != nil {
			return err
		}
	}
	if r.Autostart != nil {
		if a.cfg.Autostart == nil {
			return errors.New("Start at login is not available on this system.")
		}
		return a.cfg.Autostart.Set(*r.Autostart)
	}
	return nil
}

// ---- HTTP ---------------------------------------------------------------------------

// Handler returns the loopback HTTP handler. addr is the exact host:port being served;
// requests naming any other host are rejected (blocks DNS-rebinding from web pages).
func (a *App) Handler(addr string) http.Handler {
	mux := http.NewServeMux()
	api := func(pattern string, h func(w http.ResponseWriter, r *http.Request) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			tok := r.Header.Get("X-Linkotter-Token")
			if tok == "" {
				tok = r.URL.Query().Get("t")
			}
			if subtle.ConstantTimeCompare([]byte(tok), []byte(a.cfg.Token)) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if err := h(w, r); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": friendly(err)})
			}
		})
	}
	ok := func(w http.ResponseWriter) error { writeJSON(w, 200, map[string]bool{"ok": true}); return nil }

	api("GET /api/state", func(w http.ResponseWriter, r *http.Request) error {
		writeJSON(w, 200, a.State(r.Context()))
		return nil
	})
	api("GET /api/events", a.serveEvents)
	api("POST /api/login", func(w http.ResponseWriter, r *http.Request) error {
		var req loginReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return err
		}
		if err := a.Login(r.Context(), req); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/connect", func(w http.ResponseWriter, r *http.Request) error {
		if err := a.setRunning(r.Context(), true); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/disconnect", func(w http.ResponseWriter, r *http.Request) error {
		if err := a.setRunning(r.Context(), false); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/logout", func(w http.ResponseWriter, r *http.Request) error {
		if err := a.lc.Logout(r.Context()); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/open-auth", func(w http.ResponseWriter, r *http.Request) error {
		// Only the sign-in address the engine itself reports is ever opened.
		st, err := a.lc.StatusWithoutPeers(r.Context())
		if err != nil {
			return err
		}
		u, err := url.Parse(st.AuthURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || a.cfg.OpenURL == nil {
			return errors.New("There is no sign-in page to open right now.")
		}
		if err := a.cfg.OpenURL(st.AuthURL); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/prefs", func(w http.ResponseWriter, r *http.Request) error {
		var req prefsReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return err
		}
		if err := a.setPrefs(r.Context(), req); err != nil {
			return err
		}
		return ok(w)
	})
	api("POST /api/ping", func(w http.ResponseWriter, r *http.Request) error {
		var req struct{ ID, IP string }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return err
		}
		ip, err := netip.ParseAddr(req.IP)
		if err != nil {
			return err
		}
		q, err := a.measure(r.Context(), tailcfg.StableNodeID(req.ID), ip)
		if err != nil {
			return fmt.Errorf("No reply from that device: %w", err)
		}
		writeJSON(w, 200, Path{Kind: q.Kind, Via: q.Via, LatencyMs: &q.LatencyMs})
		return nil
	})
	api("POST /api/drop/send", a.serveDropSend)
	api("GET /api/drop/history", func(w http.ResponseWriter, r *http.Request) error {
		writeJSON(w, 200, a.drop.list())
		return nil
	})
	api("POST /api/drop/reveal", func(w http.ResponseWriter, r *http.Request) error {
		var req struct{ Path string }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return err
		}
		// Only paths we saved ourselves may be opened.
		if !a.drop.knows(req.Path) && req.Path != a.drop.dir {
			return errors.New("That file is no longer in the list.")
		}
		if a.cfg.OpenPath == nil {
			return errors.New("Cannot open folders on this system.")
		}
		if err := a.cfg.OpenPath(req.Path); err != nil {
			return err
		}
		return ok(w)
	})

	mux.Handle("/", http.FileServerFS(a.cfg.UI))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != addr {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != "http://"+addr {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:")
		mux.ServeHTTP(w, r)
	})
}

func (a *App) serveEvents(w http.ResponseWriter, r *http.Request) error {
	fl, ok := w.(http.Flusher)
	if !ok {
		return errors.New("streaming unsupported")
	}
	ch := make(chan string, 8)
	a.subMu.Lock()
	a.subs[ch] = struct{}{}
	a.subMu.Unlock()
	defer func() {
		a.subMu.Lock()
		delete(a.subs, ch)
		a.subMu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, ": ok\n\n")
	fl.Flush()
	keep := time.NewTicker(25 * time.Second)
	defer keep.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case ev := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", ev)
		case <-keep.C:
			fmt.Fprint(w, ": keep\n\n")
		}
		fl.Flush()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// friendly turns engine errors into something a person can act on.
func friendly(err error) string {
	msg := err.Error()
	var ne net.Error
	switch {
	case errors.As(err, &ne), strings.Contains(msg, "connect: "), strings.Contains(msg, "pipe"):
		if strings.Contains(msg, "tailscaled") || strings.Contains(msg, "socket") || strings.Contains(msg, "pipe") {
			return "The Linkotter service is not running on this computer."
		}
	}
	msg = strings.ReplaceAll(msg, "tailscaled", "the Linkotter service")
	msg = strings.ReplaceAll(msg, "Tailscale", "Linkotter")
	msg = strings.ReplaceAll(msg, "tailscale", "linkotter")
	return msg
}
