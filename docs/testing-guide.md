# Simple-VPN Testing Guide

Three-machine test: Linux server (anchor) + macOS client (member) + Windows client (member).

## Prerequisites

| Machine | OS | Role | Requirements |
|---------|-----|------|-------------|
| Server  | Linux | Anchor | Node.js >= 20, root access, public IP or port-forwarded UDP port |
| Mac     | macOS | Member | Node.js >= 20, admin access |
| PC      | Windows | Member | Node.js >= 20, admin access |

### All machines: one-line install

**Linux / macOS:**
```bash
git clone <repo-url> simple-vpn && cd simple-vpn && ./quickstart.sh
```

**Windows (PowerShell):**
```powershell
git clone <repo-url> simple-vpn; cd simple-vpn; .\quickstart.ps1
```

This automatically:
1. Checks Node.js >= 20
2. Installs npm dependencies
3. Compiles TypeScript
4. Checks for WireGuard, installs if missing (Linux/macOS)
5. Starts the daemon with elevated privileges
6. Opens the UI in your browser

> **Windows users**: install [WireGuard for Windows](https://www.wireguard.com/install/) manually before running quickstart if it's not already installed.

### Manual install (if quickstart fails)

```bash
git clone <repo-url> simple-vpn
cd simple-vpn
npm install
npm run build
```

---

## Step 1: Start the Anchor (Linux Server)

```bash
# Run as root (needed for interface creation)
sudo node dist/src/index.js
```

Output:
```
  simple-vpn UI: http://127.0.0.1:8420
```

The UI is accessible from the server's browser (or via SSH tunnel: `ssh -L 8420:127.0.0.1:8420 user@server`).

### Step 1a: Create the network

1. Open `http://127.0.0.1:8420` in a browser
2. Click **"I'm the Game Host (Anchor)"**
3. Enter a **Network Name** (e.g., `GameNight`)
4. Set **Listen Port** to `51820` (default)
5. Click **Create Network**

Verify on the server:
```bash
ip addr show svpn0
# Should show: inet 10.42.0.1/24 scope global svpn0

ip route show | grep 10.42
# Should show: 10.42.0.0/24 dev svpn0 proto kernel scope link src 10.42.0.1

ping -c 1 10.42.0.1
# Should respond
```

### Step 1b: Open the firewall

Ensure UDP port `51820` is reachable from the internet:

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 51820/udp

# firewalld (Fedora/RHEL)
sudo firewall-cmd --add-port=51820/udp --permanent
sudo firewall-cmd --reload

# iptables
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
```

If behind a router, forward UDP `51820` to the server's LAN IP.

### Step 1c: Note the server's public IP

```bash
curl -s ifconfig.me
# e.g., 203.0.113.50
```

Members will connect to `<public-ip>:51820`.

---

## Step 2: Invite Player 1 (macOS)

### Step 2a: Create invite on anchor

1. On the anchor's UI (`http://127.0.0.1:8420`), scroll to **Add Player**
2. Enter player name (e.g., `Alice`)
3. Click **Create Invite**
4. Copy the invite code that appears

### Step 2b: Start simple-vpn on macOS

```bash
# Run as admin (needed for interface creation)
sudo node dist/src/index.js
```

Output:
```
  simple-vpn UI: http://127.0.0.1:8420
```

### Step 2c: Import invite on macOS

1. Open `http://127.0.0.1:8420` in browser
2. Click **"I'm a Player (Member)"**
3. Paste the invite code from step 2a
4. Click **Import Invite**

The member's WG interface (`svpn1`) comes up with IP `10.42.0.2`, configured to peer with the anchor.

Verify on macOS:
```bash
ifconfig svpn1
# Should show: inet 10.42.0.2 netmask 0xffffff00

sudo wg show svpn1
# Should show peer with endpoint = <server-ip>:51820

ping -c 2 10.42.0.1
# Should respond (WG handshake completed)
```

### Step 2d: Get the reply code

After importing the invite, the UI displays a **reply code**. Copy it.

### Step 2e: Import reply on anchor

1. Go back to the anchor's UI (`http://127.0.0.1:8420`)
2. Scroll to **Import Reply**
3. Paste the reply code from step 2d
4. Click **Accept Player**

The anchor adds the member as a WG peer with allowed IP `10.42.0.2/32`.

Verify on the server:
```bash
sudo wg show svpn0
# Should show peer with allowed ips: 10.42.0.2/32
# After a few seconds, "latest handshake" should appear

ping -c 2 10.42.0.2
# Should respond
```

---

## Step 3: Invite Player 2 (Windows)

### Step 3a: Create second invite on anchor

1. On the anchor's UI, scroll to **Add Player**
2. Enter player name (e.g., `Bob`)
3. Click **Create Invite**
4. Copy the new invite code (assigned IP will be `10.42.0.3`)

### Step 3b: Start simple-vpn on Windows

Open Command Prompt or PowerShell **as Administrator**:

```powershell
node dist\src\index.js
```

Output:
```
  simple-vpn UI: http://127.0.0.1:8420
```

### Step 3c: Import invite on Windows

1. Open `http://127.0.0.1:8420` in browser
2. Click **"I'm a Player (Member)"**
3. Paste the invite code from step 3a
4. Click **Import Invite**

Verify on Windows:
```powershell
ipconfig | findstr svpn
# Should show svpn1 with 10.42.0.3

wg show svpn1
# Should show peer with endpoint = <server-ip>:51820

ping 10.42.0.1
# Should respond
```

### Step 3d: Get the reply code and import on anchor

1. Copy the reply code from the Windows UI
2. On the anchor UI, paste it into **Import Reply**
3. Click **Accept Player**

Verify on the server:
```bash
sudo wg show svpn0
# Should now show two peers:
#   10.42.0.2/32 (Alice/macOS)
#   10.42.0.3/32 (Bob/Windows)

ping -c 2 10.42.0.3
# Should respond
```

---

## Step 4: Verify Full Connectivity

### All three machines can reach each other:

**From anchor (Linux):**
```bash
ping -c 2 10.42.0.2   # macOS
ping -c 2 10.42.0.3   # Windows
```

**From macOS:**
```bash
ping -c 2 10.42.0.1   # anchor
ping -c 2 10.42.0.3   # Windows (routed through anchor)
```

**From Windows:**
```powershell
ping 10.42.0.1   # anchor
ping 10.42.0.2   # macOS (routed through anchor)
```

### WG status on all machines:

**Anchor:**
```bash
sudo wg show svpn0
# Two peers, both with recent handshakes
```

**macOS:**
```bash
sudo wg show svpn1
# One peer (anchor), with recent handshake and transfer stats
```

**Windows:**
```powershell
wg show svpn1
# One peer (anchor), with recent handshake and transfer stats
```

---

## Step 5: Test with Vintage Story

1. Start the Vintage Story server on the anchor machine, listening on port `42420`
2. On each client: **Multiplayer → Add Server →** enter `10.42.0.1:42420`
3. Click **Connect**

All three players should be in the same game.

---

## Troubleshooting

### WG handshake not completing

- Check firewall: UDP port `51820` must be open on the anchor's public IP
- Check endpoint: invite should contain anchor's **public** IP, not `127.0.0.1`
  - For remote testing, edit the invite endpoint or configure the anchor's external IP in settings
- Check `wg show` output: if `endpoint` is missing or wrong, the member can't reach the anchor

### Member can ping anchor but not other members

- This is expected in hub-and-spoke mode. The anchor routes between members.
- Ensure IP forwarding is enabled on the anchor:
  ```bash
  sudo sysctl -w net.ipv4.ip_forward=1
  ```

### Interface creation fails

- **Linux**: ensure `wireguard` kernel module is loaded (`modprobe wireguard`)
- **macOS**: ensure `wireguard-go` is installed if kernel WG is unavailable
- **Windows**: ensure WireGuard for Windows is installed (provides the Wintun driver)

### Port 8420 already in use

- Another instance is running. Kill it first:
  ```bash
  # Linux/macOS
  sudo pkill -f 'node dist/src/index.js'
  sudo rm -f /etc/simple-vpn/simple-vpn.lock

  # Windows
  taskkill /F /IM node.exe
  del "%PROGRAMDATA%\simple-vpn\simple-vpn.lock"
  ```

### Reset everything and start over

```bash
# Linux
sudo pkill -f 'node dist/src/index.js'
sudo ip link del svpn0 2>/dev/null
sudo rm -rf /etc/simple-vpn

# macOS
sudo pkill -f 'node dist/src/index.js'
sudo ifconfig svpn1 down 2>/dev/null
sudo rm -rf /Library/Application\ Support/simple-vpn

# Windows (Admin CMD)
taskkill /F /IM node.exe
netsh interface set interface "svpn1" disable 2>nul
rmdir /S /Q "%PROGRAMDATA%\simple-vpn"
```

---

## Quick Reference

| Setting | Value |
|---------|-------|
| Anchor overlay IP | `10.42.0.1` |
| Member IPs | `10.42.0.2`, `10.42.0.3`, ... |
| Subnet | `10.42.0.0/24` |
| WG listen port (anchor) | `51820` |
| WG listen port (member) | `51821` (auto-assigned) |
| UI port | `8420` |
| Game port (Vintage Story) | `42420` |
| Interface name (anchor) | `svpn0` |
| Interface name (member) | `svpn1` |
| Config dir (Linux) | `/etc/simple-vpn` |
| Config dir (macOS) | `/Library/Application Support/simple-vpn` |
| Config dir (Windows) | `%PROGRAMDATA%\simple-vpn` |
