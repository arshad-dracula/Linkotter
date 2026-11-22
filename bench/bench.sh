#!/usr/bin/env bash
# Measures connection quality from this device to one peer and appends a row to a CSV.
# Works for Linkotter and Tailscale (same client CLI) and for NetBird, so the three can be
# compared on the same route.
#
#   bench/bench.sh <peer-name-or-ip> [label] [count]
#
#   label   free text for the "product" column: linkotter (default), tailscale, netbird
#   count   pings per test (default 30)
#
# Environment:
#   CLI        client command (default: "tailscale"; use "netbird" for NetBird)
#   IPERF=1    also run a 10 s iperf3 throughput test each way (peer must run `iperf3 -s`)
#   OUT        CSV path (default: bench/results/results.csv)
set -euo pipefail

peer=${1:?usage: bench.sh <peer> [label] [count]}
label=${2:-linkotter}
count=${3:-30}
CLI=${CLI:-tailscale}
OUT=${OUT:-"$(dirname "$0")/results/results.csv"}
mkdir -p "$(dirname "$OUT")"

# min/avg/p95/max from a list of millisecond values on stdin
stats() {
  grep . | sort -n | awk '{v[NR]=$1; s+=$1} END {
    if (NR==0) {print ",,,"; exit}
    i=int(NR*0.95+0.999); if (i<1) i=1; if (i>NR) i=NR
    printf "%.3f,%.3f,%.3f,%.3f", v[1], s/NR, v[i], v[NR] }'
}

path=unknown; relay=""; samples=""; lost=0; first_direct_s=""

if [[ $CLI == *netbird* ]]; then
  # NetBird has no built-in ping; use ICMP and read the path from `status -d`.
  detail=$($CLI status -d 2>/dev/null | awk -v p="$peer" '
    /^ [^ ].*:$/ {cur=$1} index($0,p) {hit=1} hit && /Connection type:/ {print $3; exit}') || true
  case "${detail,,}" in p2p) path=direct ;; relayed) path=relay ;; esac
  raw=$(ping -c "$count" -i 0.2 "$peer" 2>&1 || true)
  samples=$(grep -o 'time=[0-9.]*' <<<"$raw" | cut -d= -f2)
  lost=$(( count - $(grep -c . <<<"$samples" || true) ))
else
  # `ping` output: "pong from host (ip) via 1.2.3.4:41641 in 23ms"
  #                "pong from host (ip) via DERP(dxb) in 80ms"
  #                "pong from host (ip) via peer-relay(1.2.3.4:40000:vni:5) in 30ms"
  start=$(date +%s.%N)
  raw=$($CLI ping --until-direct=false -c "$count" --timeout 3s "$peer" 2>&1 || true)
  pongs=$(grep '^pong from' <<<"$raw" || true)
  # latency is printed as e.g. "23ms", "480µs" or "1.2s"; normalise to milliseconds
  samples=$(sed -n 's/.* in \([0-9.]*\)\([a-zµ]*\)$/\1 \2/p' <<<"$pongs" |
    awk '{m=1; if ($2=="s") m=1000; else if ($2=="µs" || $2=="us") m=0.001; printf "%.3f\n", $1*m}')
  lost=$(( count - $(grep -c . <<<"$samples" || true) ))
  last=$(tail -n1 <<<"$pongs")
  case "$last" in
    *"via DERP("*)       path=relay;      relay=$(sed -n 's/.*via DERP(\([^)]*\)).*/\1/p' <<<"$last") ;;
    *"via peer-relay("*) path=peer-relay; relay=$(sed -n 's/.*via peer-relay(\([^)]*\)).*/\1/p' <<<"$last") ;;
    *" via "*)           path=direct ;;
  esac
  # How long a fresh connection takes to go direct (blank if it never does within 15 s).
  if out=$($CLI ping --until-direct=true -c 50 --timeout 300ms "$peer" 2>&1) && grep -q 'via [0-9\[]' <<<"$out"; then
    first_direct_s=$(awk -v s="$start" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}')
  fi
fi

up=""; down=""
if [[ ${IPERF:-0} == 1 ]] && command -v iperf3 >/dev/null; then
  mbps() { iperf3 -c "$peer" -t 10 -J "$@" 2>/dev/null |
    python3 -c 'import json,sys; print(round(json.load(sys.stdin)["end"]["sum_received"]["bits_per_second"]/1e6,1))' 2>/dev/null || true; }
  up=$(mbps); down=$(mbps -R)
fi

[[ -s $OUT ]] || echo "time_utc,product,from,peer,path,relay,sent,lost,min_ms,avg_ms,p95_ms,max_ms,up_mbps,down_mbps,note" > "$OUT"
row="$(date -u +%FT%TZ),$label,$(hostname),$peer,$path,\"$relay\",$count,$lost,$(stats <<<"$samples"),$up,$down,${NOTE:-}"
echo "$row" >> "$OUT"
echo "$row"
