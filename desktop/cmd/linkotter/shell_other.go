//go:build !windows

package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/arshad-dracula/linkotter/desktop/internal/app"
)

// On macOS and Linux the native shell is not built yet; the interface opens in the browser.

func opener() string {
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func openWindow(url string) { exec.Command(opener(), url).Start() }

func runWindow(url string) { openWindow(url) }

func runShell(ctx context.Context, quit func(), url string, show bool) {
	fmt.Println(url)
	if show {
		openWindow(url)
	}
	<-ctx.Done()
}

func autostart() app.Autostart { return nil }

func revealPath(path string) error { return exec.Command(opener(), filepath.Dir(path)).Start() }

func openURL(url string) error { return exec.Command(opener(), url).Start() }
