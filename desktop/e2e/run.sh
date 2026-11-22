#!/usr/bin/env bash
# End-to-end test of the desktop app against a real control server and real engine processes,
# all on this machine (userspace networking, no root needed).
#
#   HEADSCALE=/path/to/headscale TS_BIN=/dir/with/tailscale+tailscaled e2e/run.sh
#
# Starts: control server, three engines ("laptop" = the app under test, "phone" = same user,
# "nas" = tagged shared device), the Linkotter backend for "laptop", then drives the interface
# with a headless browser (e2e/test.mjs).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${HEADSCALE:?path to headscale binary}" "${TS_BIN:?directory containing tailscale and tailscaled}"
HEADSCALE=$(realpath "$HEADSCALE"); TS_BIN=$(realpath "$TS_BIN")
work=$(mktemp -d); cd "$work"   # relative socket paths below keep under the unix-socket length limit
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; [ -n "${KEEP:-}" ] || rm -rf "$work"; }
trap cleanup EXIT

(cd "$here/.." && go build -o "$work/linkotter" ./cmd/linkotter)

HS_PORT=${HS_PORT:-18080} UI_PORT=${UI_PORT:-18999}
mkdir -p hs home
cat > hs/config.yaml <<YAML
server_url: http://127.0.0.1:$HS_PORT
listen_addr: 127.0.0.1:$HS_PORT
metrics_listen_addr: 127.0.0.1:0
grpc_listen_addr: 127.0.0.1:0
noise: {private_key_path: hs/noise.key}
prefixes: {v4: 100.64.0.0/10, v6: "fd7a:115c:a1e0::/48", allocation: sequential}
derp:
  server: {enabled: true, region_id: 900, region_code: in, region_name: India office, verify_clients: true,
           stun_listen_addr: "127.0.0.1:0", private_key_path: hs/derp.key,
           automatically_add_embedded_derp_region: true, ipv4: 127.0.0.1}
  urls: []
  paths: []
disable_check_updates: true
database: {type: sqlite, sqlite: {path: hs/db.sqlite, write_ahead_log: true}}
log: {level: warn}
policy: {mode: file, path: $here/../../deploy/templates/policy.hujson}
dns: {magic_dns: true, base_domain: mesh.test, override_local_dns: false, nameservers: {global: []}}
unix_socket: hs/hs.sock
unix_socket_permission: "0770"
taildrop: {enabled: true}
YAML
"$HEADSCALE" serve -c hs/config.yaml > hs.log 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$HS_PORT/health" >/dev/null && break; sleep 0.2; done
hs() { "$HEADSCALE" -c hs/config.yaml "$@"; }
key() { hs preauthkeys create "$@" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])'; }
hs users create arshad >/dev/null
USER_KEY=$(key --user 1 --reusable); NAS_KEY=$(key --tags tag:nas)

for n in laptop phone nas; do
  mkdir -p "$n"
  "$TS_BIN/tailscaled" --no-logs-no-support --tun=userspace-networking --statedir="$n" --socket="$n.sock" --port=0 > "$n.log" 2>&1 & pids+=($!)
done
sleep 2
ts() { local n=$1; shift; "$TS_BIN/tailscale" --socket="$n.sock" "$@"; }
ts phone up --login-server="http://127.0.0.1:$HS_PORT" --authkey="$USER_KEY" --hostname=phone --accept-dns=false
ts nas   up --login-server="http://127.0.0.1:$HS_PORT" --authkey="$NAS_KEY"  --hostname=nas-india --accept-dns=false

HOME="$work/home" ./linkotter --headless --socket=laptop.sock --port="$UI_PORT" --token=e2e --data-dir="$work/data" \
  --server="http://127.0.0.1:$HS_PORT" > app.log 2>&1 & pids+=($!)
sleep 1

export UI="http://127.0.0.1:$UI_PORT/#t=e2e" USER_KEY WORK="$work" SHOTS="${SHOTS:-$work/shots}"
export PHONE_SEND="$TS_BIN/tailscale --socket=phone.sock file cp"
export PHONE_GET="$TS_BIN/tailscale --socket=phone.sock file get"
mkdir -p "$SHOTS"
node "$here/test.mjs" || { echo "--- app.log"; tail -20 app.log; echo "--- laptop.log"; tail -20 laptop.log; exit 1; }
