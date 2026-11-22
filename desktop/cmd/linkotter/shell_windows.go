package main

import (
	"context"
	_ "embed"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"fyne.io/systray"
	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows/registry"

	"github.com/arshad-dracula/linkotter/desktop/internal/app"
)

//go:embed linkotter.ico
var trayIcon []byte

func self() string {
	exe, err := os.Executable()
	if err != nil {
		return os.Args[0]
	}
	return exe
}

// openWindow starts the window process for a running backend.
func openWindow(url string) {
	exec.Command(self(), "--window", url).Start()
}

// runWindow shows the interface in a native window and returns when it is closed.
func runWindow(url string) {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "Linkotter",
			Width:  460,
			Height: 780,
			IconId: 1, // icon resource embedded in the executable
			Center: true,
		},
	})
	if w == nil {
		// WebView2 runtime missing (very old Windows 10): fall back to the default browser.
		openURL(url)
		return
	}
	defer w.Destroy()
	w.SetSize(460, 780, webview2.HintNone)
	w.Navigate(url)
	w.Run()
}

// runShell owns the tray icon until the user chooses Quit.
func runShell(ctx context.Context, quit func(), url string, show bool) {
	systray.Run(func() {
		systray.SetIcon(trayIcon)
		systray.SetTitle("Linkotter")
		systray.SetTooltip("Linkotter")
		systray.SetOnTapped(func() { openWindow(url) })
		open := systray.AddMenuItem("Open Linkotter", "")
		systray.AddSeparator()
		exit := systray.AddMenuItem("Quit", "Close the Linkotter app. The connection stays up if \"Stay connected in the background\" is on.")
		if show {
			openWindow(url)
		}
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					openWindow(url)
				case <-exit.ClickedCh:
					systray.Quit()
					return
				case <-ctx.Done():
					systray.Quit()
					return
				}
			}
		}()
	}, quit)
}

// ---- start at login -------------------------------------------------------------------

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

type runKeyAutostart struct{}

func autostart() app.Autostart { return runKeyAutostart{} }

func (runKeyAutostart) Enabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetStringValue("Linkotter")
	return err == nil && strings.Contains(strings.ToLower(v), strings.ToLower(self()))
}

func (runKeyAutostart) Set(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue("Linkotter"); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	return k.SetStringValue("Linkotter", `"`+self()+`" --minimized`)
}

func revealPath(path string) error {
	cmd := exec.Command("explorer.exe")
	// explorer needs the argument unquoted-then-quoted exactly like this to select the file.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + path + `"`}
	cmd.Start() // explorer returns a non-zero exit code even on success
	return nil
}

func openURL(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
