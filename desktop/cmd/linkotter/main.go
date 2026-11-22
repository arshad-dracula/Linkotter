// Linkotter desktop app.
//
// One background process owns the tray icon, the loopback backend and the Drop receiver.
// The window is a second, short-lived process (linkotter --window URL) so closing it
// never interrupts the connection or file transfers.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/arshad-dracula/linkotter/desktop/internal/app"
	"github.com/arshad-dracula/linkotter/desktop/ui"
)

// Set at build time with -ldflags "-X main.version=... -X main.defaultServer=...".
var (
	version       = "dev"
	defaultServer = ""
)

type instance struct {
	URL string `json:"url"`
}

func main() {
	var (
		socket    = flag.String("socket", "", "engine socket path (default: system service)")
		port      = flag.Int("port", 0, "loopback port for the interface (default: random)")
		token     = flag.String("token", "", "API token (default: random)")
		server    = flag.String("server", defaultServer, "control server offered at sign-in")
		headless  = flag.Bool("headless", false, "run the backend only and print its address")
		minimized = flag.Bool("minimized", false, "start in the tray without opening the window")
		window    = flag.String("window", "", "internal: show the window for this backend address")
		dataDir   = flag.String("data-dir", "", "settings folder (default: per-user config folder)")
	)
	flag.Parse()

	if *window != "" {
		runWindow(*window)
		return
	}

	if *dataDir == "" {
		cfgDir, err := os.UserConfigDir()
		if err != nil {
			log.Fatal(err)
		}
		*dataDir = filepath.Join(cfgDir, "Linkotter")
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	instFile := filepath.Join(*dataDir, "instance.json")

	// Already running? Just bring its window up.
	if !*headless {
		if url := liveInstance(instFile); url != "" {
			openWindow(url)
			return
		}
	}

	if *token == "" {
		b := make([]byte, 24)
		if _, err := rand.Read(b); err != nil {
			log.Fatal(err)
		}
		*token = hex.EncodeToString(b)
	}
	home, _ := os.UserHomeDir()
	a, err := app.New(app.Config{
		Socket:        *socket,
		DefaultServer: *server,
		Token:         *token,
		DataDir:       *dataDir,
		DownloadDir:   filepath.Join(home, "Downloads", "Linkotter"),
		Version:       version,
		UI:            ui.FS(),
		Autostart:     autostart(),
		OpenPath:      revealPath,
		OpenURL:       openURL,
	})
	if err != nil {
		log.Fatal(err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	addr := ln.Addr().String()
	url := fmt.Sprintf("http://%s/#t=%s", addr, *token)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	srv := &http.Server{Handler: a.Handler(addr), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	go a.Run(ctx)

	if b, err := json.Marshal(instance{URL: url}); err == nil {
		os.WriteFile(instFile, b, 0o600)
		defer os.Remove(instFile)
	}

	if *headless {
		fmt.Println(url)
		<-ctx.Done()
	} else {
		runShell(ctx, stop, url, !*minimized)
	}
	shut, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(shut)
}

// liveInstance returns the address of an already-running Linkotter, or "".
func liveInstance(instFile string) string {
	b, err := os.ReadFile(instFile)
	if err != nil {
		return ""
	}
	var in instance
	if json.Unmarshal(b, &in) != nil || in.URL == "" {
		return ""
	}
	c := http.Client{Timeout: time.Second}
	resp, err := c.Get(in.URL) // serves index.html if alive
	if err != nil {
		return ""
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	return in.URL
}
