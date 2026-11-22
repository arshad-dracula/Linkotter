// Package ui holds the interface files served by the desktop backend.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed dist
var files embed.FS

// FS is the root of the interface (index.html at the top).
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
