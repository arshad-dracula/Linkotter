#!/usr/bin/env bash
# Starts a Linkotter control server on this computer for a local-network test.
#   deploy/local-test/setup.sh [lan-ip]
# Needs Docker. Prints the server address and access keys for your devices.
set -euo pipefail
cd "$(dirname "$0")"
PORT=${PORT:-8080}

ip=${1:-}
if [ -z "$ip" ]; then
  if command -v ip >/dev/null; then ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}'); fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null; then ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true); fi
fi
[ -n "$ip" ] || { echo "Could not find this computer's local IP address; pass it: setup.sh 192.168.1.20" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker and run this again." >&2; exit 1; }

mkdir -p config
sed -e "s|@LAN_IP@|$ip|g" -e "s|@PORT@|$PORT|g" config.yaml.tmpl > config/config.yaml
sed -e "s|@LAN_IP@|$ip|g" derp.yaml.tmpl > config/derp.yaml
cp ../templates/policy.hujson config/policy.hujson

PORT=$PORT docker compose up -d
url="http://$ip:$PORT"
for _ in $(seq 60); do curl -fs "$url/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$url/health" >/dev/null || { echo "Server did not come up; see: docker logs linkotter-local" >&2; exit 1; }

hs() { docker exec linkotter-local headscale "$@"; }
hs users list -o json | grep -q '"name": *"me"' || hs users create me >/dev/null
uid=$(hs users list -o json | python3 -c 'import json,sys; print(next(u["id"] for u in json.load(sys.stdin) if u["name"]=="me"))')
key=$(hs preauthkeys create --user "$uid" --reusable --expiration 168h -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')

cat <<MSG

Linkotter local test server is running.

  Server address:  $url
  Access key:      $key   (works on all your devices for 7 days)

On each device, open Linkotter, enter the server address, tap "I have an access key" and paste the key.
Devices must be on the same network as this computer for this test. Stop the server with:
  docker compose -f $(pwd)/docker-compose.yml down
MSG
