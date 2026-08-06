# Deploying Relay for free, forever (Oracle Cloud "Always Free")

Unlike Railway (time/credit-limited) or Render's free tier (spins down, temporary free
Postgres), Oracle Cloud's **Always Free** tier is a genuinely permanent allowance — up to 4
ARM (Ampere A1) CPU cores and 24GB RAM, split across up to 4 VMs, for as long as your account
stays within those limits. The trade-off versus Railway: there's no managed platform doing
the work for you — you're running a real VM, so you handle firewall rules, TLS, and updates
yourself. This guide covers all of that, end to end, using the `docker-compose.prod.yml` and
`deploy/Caddyfile` already in this repo.

Everything here runs on **one VM**: Postgres + Redis + the backend + Caddy (which serves the
built frontend directly and reverse-proxies API/WebSocket traffic to the backend) all in one
`docker compose` stack, on one domain, one TLS cert.

## 1. Create the VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (a card is required for identity
   verification, but Always Free resources are never billed as long as you stay within them).
2. Compute → Instances → **Create instance**.
   - **Image:** Ubuntu 22.04 (or 24.04), **Shape:** Ampere (ARM) `VM.Standard.A1.Flex` — pick
     2 OCPU / 12GB RAM (comfortably within the Always Free allowance).
   - Add your SSH public key.
   - Under Networking, assign a **public IPv4 address**.
3. Once running, note the public IP. Optionally reserve it (Networking → Reserved Public IPs)
   so it doesn't change on a stop/start — useful since your domain will point at it.

## 2. Open the firewall — two layers, both need fixing

Oracle blocks inbound traffic in **two places**: the cloud-level Security List, and the VM's
own `iptables` rules (Ubuntu images ship with extra rules that block everything but SSH even
if the Security List allows it — a well-known Oracle gotcha).

**Security List** (Networking → Virtual Cloud Networks → your VCN → Security Lists → default):
add Ingress Rules for `0.0.0.0/0` → TCP port `80` and TCP port `443`.

**On the VM itself**, over SSH:
```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # persist across reboots
```

## 3. Get a free domain (DuckDNS)

You need a real hostname for Let's Encrypt to issue a TLS cert (a bare IP won't work).
[duckdns.org](https://www.duckdns.org) gives free subdomains, permanently, with no renewal:

1. Sign in (GitHub/Google), create a subdomain, e.g. `relay-yourname.duckdns.org`.
2. Point it at your VM's public IP (paste the IP into DuckDNS's "current ip" field and update).

## 4. Install Docker on the VM

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker          # or log out/in
docker --version && docker compose version
```

## 5. Get the code and build the frontend

```bash
sudo apt update && sudo apt install -y git nodejs npm
git clone <your-repo-url> chat_app
cd chat_app/frontend
npm install
npm run build          # produces frontend/dist, which Caddy will serve directly
cd ..
```

## 6. Run the stack

```bash
export DOMAIN=relay-yourname.duckdns.org
export JWT_SECRET=$(openssl rand -hex 32)
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy automatically requests and renews a Let's Encrypt certificate for `$DOMAIN` the first
time it starts (this needs port 80 reachable for the HTTP-01 challenge — that's why step 2
matters). Check logs if it doesn't come up clean:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
docker compose -f docker-compose.prod.yml logs -f backend
```

## 7. Verify

Visit `https://relay-yourname.duckdns.org` — you should see the Relay login page over a
valid HTTPS cert. Sign up two accounts and run through the same checklist as local testing:
real-time messages, the P2P badge, voice + video calls, logout. This time you can genuinely
test from two different networks/devices (e.g. your phone on mobile data vs. your laptop on
WiFi) — that's the one thing local testing can never actually exercise (see the app's `README.md`
"Known limitations" for why that matters for the P2P/calling path specifically).

## Reboots, restarts, updates

- All services have `restart: unless-stopped` and Docker itself starts on boot after the
  install above — a VM reboot brings everything back up on its own.
- To deploy a code update:
  ```bash
  git pull
  cd frontend && npm run build && cd ..     # only if frontend changed
  docker compose -f docker-compose.prod.yml up -d --build
  ```
- Uploaded files and the Postgres database persist in Docker named volumes on this VM's disk
  (unlike Railway's ephemeral containers) — back up `/var/lib/docker/volumes/` if that matters
  to you.
