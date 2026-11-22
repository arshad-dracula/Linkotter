# Server setup (office NAS, proof of concept)

Two sites, both on Docker:

| Site | Folder | Runs |
|---|---|---|
| India NAS | `control/` | control server, India relay, always-on node |
| Dubai NAS | `relay/` | Dubai relay, always-on node |

If the control server is offline, devices that are already connected keep working, but
nobody can log in, add a device or change settings until it is back.

## Before you start

Each office needs:

1. **A static public IPv4 address.**
2. **A DNS name pointing at it**, e.g. `link.example.com` (India) and `dxb.link.example.com` (Dubai).
3. **These ports forwarded on the router to the NAS:**

   | Public port | To NAS port | Purpose |
   |---|---|---|
   | TCP 443 | `HOST_HTTPS_PORT` (default 443) | control server / relay, and certificate issuance |
   | UDP 3478 | 3478 | NAT discovery (STUN) |
   | UDP 41641 | 41641 | direct connections to the NAS node |
   | UDP 41642 | 41642 | peer relay on the NAS node |

   Public TCP 443 is not optional: clients and Let's Encrypt both expect it. If the NAS
   admin page already uses 443, set `HOST_HTTPS_PORT` to another port and forward public 443 to that.
4. **Docker with Compose v2** and the TUN device (`/dev/net/tun`) on the NAS.

## India NAS

```sh
cd deploy
cp .env.example .env        # fill in hostnames, IPs, email; NODE_HOSTNAME=nas-india
./render.sh                 # writes control/config/
cd control
docker compose --env-file ../.env up -d
curl https://<CONTROL_HOSTNAME>/health      # {"status":"pass"} once the certificate is issued
```

Create your user and the keys that devices join with:

```sh
alias hs='docker exec linkotter-control headscale'
hs users create <your-name>
hs users list                                   # note the numeric ID
hs preauthkeys create --user <ID> --reusable --expiration 24h   # for your laptop and phone
hs preauthkeys create --tags tag:nas --reusable --expiration 24h  # for the two NAS nodes
```

Start the NAS's own node: put the `tag:nas` key in `.env` as `NODE_AUTHKEY`, then

```sh
docker compose --env-file ../.env --profile node up -d
docker exec linkotter-node tailscale set --relay-server-port=41642 \
  --relay-server-static-endpoints=<INDIA_PUBLIC_IPV4>:41642
```

If the node cannot reach `CONTROL_HOSTNAME` from inside the office (router without NAT
loopback), add a hosts entry on the NAS mapping the name to the NAS's LAN address.

## Dubai NAS

Same `.env` values, except `NODE_HOSTNAME=nas-dubai` and Dubai's `LAN_ROUTES`. No `render.sh` needed.

```sh
cd deploy/relay
docker compose --env-file ../.env up -d --build
docker compose --env-file ../.env --profile node up -d     # after setting NODE_AUTHKEY
docker exec linkotter-node tailscale set --relay-server-port=41642 \
  --relay-server-static-endpoints=<DUBAI_PUBLIC_IPV4>:41642
```

## Connect a device (until the Linkotter apps exist)

Install the stock Tailscale client and point it at our server.

- **Windows / macOS / Linux:** `tailscale up --login-server=https://<CONTROL_HOSTNAME> --authkey=<key> --accept-dns=true`
- **Android:** on the sign-in screen open the menu, choose the option to use a custom/alternate
  server, enter `https://<CONTROL_HOSTNAME>`, then sign in with the auth key. Menu wording varies by app version.

A device can be on Tailscale's cloud or on Linkotter, not both at once, while it uses the stock client.

## Check it works

```sh
tailscale status                 # every device listed
tailscale netcheck               # shows "in" and "dxb" relay latency
tailscale ping nas-dubai         # "via <ip:port>" = direct, "via DERP(..)" = relay, "via peer-relay(..)" = NAS relay
tailscale file cp photo.jpg <your-other-device>:     # file drop (own devices only, for now)
```

Measure and record: `bench/bench.sh nas-dubai linkotter`. Run the same command with the label
`tailscale` while on Tailscale's cloud, and `CLI=netbird bench/bench.sh <peer> netbird` on NetBird,
to compare on the same route. Results go to `bench/results/results.csv`.

## What was verified, and what was not

Verified in a local test (Headscale 0.29.7, Tailscale 1.104.7): this configuration and policy load,
user and tagged devices join with pre-auth keys, devices connect directly, the relay map lists both
regions, the peer-relay setting is accepted, and file drop delivers between two devices of one user.

Not yet verified, because it needs the real NAS boxes and routers: Let's Encrypt issuance, the
Docker Compose stack itself, the Dubai relay build, port forwarding, and peer relay through office NAT.
