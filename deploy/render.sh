#!/usr/bin/env bash
# Renders deploy/templates/* into deploy/control/config/ using values from deploy/.env.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "deploy/.env not found - copy .env.example to .env and fill it in" >&2; exit 1; }
set -a; . ./.env; set +a

required=(CONTROL_HOSTNAME INDIA_PUBLIC_IPV4 DUBAI_RELAY_HOSTNAME DUBAI_PUBLIC_IPV4 ACME_EMAIL MESH_DOMAIN)
for v in "${required[@]}"; do
  [ -n "${!v:-}" ] || { echo "$v is empty in deploy/.env" >&2; exit 1; }
done
case ".$CONTROL_HOSTNAME" in
  *".$MESH_DOMAIN") echo "MESH_DOMAIN must not equal or contain CONTROL_HOSTNAME" >&2; exit 1 ;;
esac

out=control/config
mkdir -p "$out"
render() {
  local src=$1 dst=$2 args=() v
  for v in "${required[@]}"; do args+=(-e "s|@$v@|${!v}|g"); done
  sed "${args[@]}" "$src" > "$dst"
  if grep -q '@[A-Z0-9_]*@' "$dst"; then echo "unfilled placeholder in $dst" >&2; exit 1; fi
}
render templates/config.yaml.tmpl "$out/config.yaml"
render templates/derp.yaml.tmpl   "$out/derp.yaml"
cp templates/policy.hujson "$out/policy.hujson"
echo "Rendered $out/{config.yaml,derp.yaml,policy.hujson}"
