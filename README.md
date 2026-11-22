# Linkotter

A private mesh network for PropVR devices, servers and NAS boxes, built on the open-source
Tailscale engine with our own control server, relays and apps.

| Layer | Choice |
|---|---|
| Tunnel engine | Tailscale open-source core (WireGuard, BSD licence) |
| Control server | Headscale 0.29 (BSD licence), self-hosted |
| Relays | Our own, one per region (India, Dubai), plus NAS peer relays |
| Apps | Android (fork of the open-source app), Windows / macOS / iOS (own interface) |
| Design | PropVR design system |

## Status

Phase 1, proof of concept. What exists:

- `deploy/` - control server and relays for the India and Dubai office NAS. Start with [deploy/README.md](deploy/README.md).
- `desktop/` - the Linkotter desktop app (Windows first): sign in, device list with live path and latency,
  Drop (send and receive files, with history), settings. Built and smoke-tested on Windows in CI.
- `android/` - the Android app: the open-source client rebranded and built in CI.
- `bench/` - latency and throughput measurement, for comparing against Tailscale and NetBird.

## Getting the apps

Every push builds the apps in GitHub Actions. Open the repository's **Actions** tab, pick the latest green run of
**Windows app** or **Android APK**, and download the file under **Artifacts**.

- **Windows:** unzip and run `LinkotterSetup.exe`. The build is not code-signed yet, so Windows SmartScreen shows a
  warning: choose "More info", then "Run anyway". Tailscale must not be installed on the same PC (see limits below).
- **Android:** unzip and open the `.apk` on the phone, allowing installation from that source when asked.

Sign in with the server address (`https://<CONTROL_HOSTNAME>`) and an access key from
[deploy/README.md](deploy/README.md). To bake the server address in, set the repository variable
`LINKOTTER_CONTROL_URL` (Settings, Secrets and variables, Actions, Variables) and re-run the builds.

## Known limits of these first builds

- **Windows engine is not renamed yet.** It installs as a Windows service called "Tailscale" and keeps its data in
  `ProgramData\Tailscale`, so it cannot sit next to a real Tailscale install. The installer refuses to run if it finds one.
- **Android screens still follow the upstream layout** with Linkotter name, icon and PropVR colours; the interface
  has not been redesigned. It installs next to the Tailscale app without conflict.
- **Android test builds are signed with a throwaway key.** If a newer APK refuses to install over an older one,
  uninstall the old one first. A permanent signing key has to be added as a repository secret before wider rollout.
- **No code signing on Windows**, no auto-update, no macOS or iOS apps yet.
- **Drop reaches your own devices only** (not teammates or the NAS); that restriction comes from the engine and is
  the first thing to lift.

## Developing the desktop app

```sh
cd desktop
go test ./...
HEADSCALE=/path/to/headscale TS_BIN=/dir/with/tailscale-binaries e2e/run.sh   # full flow in a headless browser
```
