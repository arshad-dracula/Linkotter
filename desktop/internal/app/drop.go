package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/tailcfg"
)

// Transfer is one line of Drop history. Unlike upstream's file sharing, which forgets a
// transfer as soon as it finishes, Linkotter keeps a local record of what went where.
type Transfer struct {
	Time   string `json:"time"`
	Dir    string `json:"dir"` // in, out
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Peer   string `json:"peer,omitempty"`
	Path   string `json:"path,omitempty"` // saved location, for received files
	Failed string `json:"failed,omitempty"`
}

type dropStore struct {
	mu   sync.Mutex
	file string
	dir  string
	hist []Transfer
}

const maxHistory = 200

func newDropStore(dataDir, downloadDir string) (*dropStore, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	ds := &dropStore{file: filepath.Join(dataDir, "drop-history.json"), dir: downloadDir}
	if b, err := os.ReadFile(ds.file); err == nil {
		json.Unmarshal(b, &ds.hist)
	}
	return ds, nil
}

func (d *dropStore) add(t Transfer) {
	t.Time = time.Now().UTC().Format(time.RFC3339)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.hist = append([]Transfer{t}, d.hist...)
	if len(d.hist) > maxHistory {
		d.hist = d.hist[:maxHistory]
	}
	if b, err := json.Marshal(d.hist); err == nil {
		tmp := d.file + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			os.Rename(tmp, d.file)
		}
	}
}

func (d *dropStore) list() []Transfer {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]Transfer{}, d.hist...)
}

func (d *dropStore) knows(path string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, t := range d.hist {
		if t.Path != "" && t.Path == path {
			return true
		}
	}
	return false
}

// uniquePath never overwrites: "plan.pdf" becomes "plan (2).pdf" if it already exists.
func uniquePath(dir, name string) string {
	name = filepath.Base(filepath.Clean("/" + name)) // no directories from the sender
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "file"
	}
	p := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
	}
}

// receiveLoop saves incoming files into the download folder as they arrive.
func (a *App) receiveLoop(ctx context.Context) {
	for ctx.Err() == nil {
		files, err := a.lc.AwaitWaitingFiles(ctx, 50*time.Second)
		if err != nil {
			// Not running, signed out, or simply nothing arrived in time.
			sleep(ctx, 3*time.Second)
			continue
		}
		got := false
		for _, f := range files {
			if err := a.saveIncoming(ctx, f.Name, f.Size); err != nil {
				a.drop.add(Transfer{Dir: "in", Name: f.Name, Size: f.Size, Failed: friendly(err)})
			}
			got = true
		}
		if got {
			a.publish("drop")
		}
	}
}

func (a *App) saveIncoming(ctx context.Context, name string, size int64) error {
	if err := os.MkdirAll(a.drop.dir, 0o755); err != nil {
		return err
	}
	rc, _, err := a.lc.GetWaitingFile(ctx, name)
	if err != nil {
		return err
	}
	defer rc.Close()
	dst := uniquePath(a.drop.dir, name)
	part := dst + ".part"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, rc)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(part)
		return err
	}
	if err := os.Rename(part, dst); err != nil {
		os.Remove(part)
		return err
	}
	// Only now is it safe to drop the engine's copy.
	if err := a.lc.DeleteWaitingFile(ctx, name); err != nil {
		return err
	}
	a.drop.add(Transfer{Dir: "in", Name: filepath.Base(dst), Size: n, Path: dst})
	return nil
}

// serveDropSend streams one file to one device: POST /api/drop/send?to=<id>&name=<file>&peer=<label>
func (a *App) serveDropSend(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	to, name := q.Get("to"), filepath.Base(q.Get("name"))
	if to == "" || name == "" || name == "." {
		return errors.New("Choose a device and a file.")
	}
	if r.ContentLength < 0 {
		return errors.New("File size unknown.")
	}
	err := a.lc.PushFile(r.Context(), tailcfg.StableNodeID(to), r.ContentLength, name, r.Body)
	t := Transfer{Dir: "out", Name: name, Size: r.ContentLength, Peer: q.Get("peer")}
	if err != nil {
		t.Failed = friendly(err)
	}
	a.drop.add(t)
	a.publish("drop")
	if err != nil {
		return fmt.Errorf("Could not send %s: %w", name, err)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
	return nil
}
