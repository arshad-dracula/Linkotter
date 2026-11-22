package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestNormalizeServer(t *testing.T) {
	ok := map[string]string{
		"link.example.com":                "https://link.example.com",
		" https://link.example.com/ ":     "https://link.example.com",
		"https://link.example.com:8443/x": "https://link.example.com:8443",
		"http://127.0.0.1:8080":           "http://127.0.0.1:8080",
	}
	for in, want := range ok {
		got, err := normalizeServer(in)
		if err != nil || got != want {
			t.Errorf("normalizeServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "not a url", "ftp://x.example.com", "https://"} {
		if got, err := normalizeServer(in); err == nil {
			t.Errorf("normalizeServer(%q) = %q; want error", in, got)
		}
	}
}

func TestUniquePathNeverOverwritesOrEscapes(t *testing.T) {
	dir := t.TempDir()
	first := uniquePath(dir, "plan.pdf")
	if first != filepath.Join(dir, "plan.pdf") {
		t.Fatalf("got %q", first)
	}
	os.WriteFile(first, nil, 0o600)
	if got := uniquePath(dir, "plan.pdf"); got != filepath.Join(dir, "plan (2).pdf") {
		t.Errorf("second file: got %q", got)
	}
	// A sender must not be able to choose where the file lands.
	for _, evil := range []string{"../../evil.sh", "/etc/passwd", "..", "", "a/b/c.txt"} {
		got := uniquePath(dir, evil)
		if filepath.Dir(got) != dir {
			t.Errorf("uniquePath(%q) = %q escapes %q", evil, got, dir)
		}
	}
}

func TestHandlerGuards(t *testing.T) {
	a, err := New(Config{Token: "secret", DataDir: t.TempDir(), DownloadDir: t.TempDir(),
		Socket: filepath.Join(t.TempDir(), "none.sock"),
		UI:     fstest.MapFS{"index.html": {Data: []byte("hi")}}})
	if err != nil {
		t.Fatal(err)
	}
	h := a.Handler("127.0.0.1:1234")
	do := func(host, origin, token, path string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if token != "" {
			r.Header.Set("X-Linkotter-Token", token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	cases := []struct {
		name                      string
		host, origin, token, path string
		want                      int
	}{
		{"right token", "127.0.0.1:1234", "", "secret", "/api/state", http.StatusOK},
		{"no token", "127.0.0.1:1234", "", "", "/api/state", http.StatusForbidden},
		{"wrong token", "127.0.0.1:1234", "", "nope", "/api/state", http.StatusForbidden},
		{"other hostname (DNS rebinding)", "evil.example.com:1234", "", "secret", "/api/state", http.StatusForbidden},
		{"other website's origin", "127.0.0.1:1234", "https://evil.example.com", "secret", "/api/state", http.StatusForbidden},
		{"static page needs no token", "127.0.0.1:1234", "", "", "/", http.StatusOK},
	}
	for _, c := range cases {
		if got := do(c.host, c.origin, c.token, c.path); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}
