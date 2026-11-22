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

Phase 1, proof of concept: the control server and both relays run on the office NAS boxes;
stock Tailscale clients connect to them. Branded apps come next.

- `deploy/` - server setup for the India and Dubai NAS. Start with [deploy/README.md](deploy/README.md).
- `bench/` - latency and throughput measurement, for comparing against Tailscale and NetBird.
