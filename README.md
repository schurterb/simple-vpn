# simple-vpn

Lightweight, self-hosted VPN for friends playing Vintage Story together. Creates a virtual LAN across the internet using WireGuard — no third-party servers, accounts, or always-on VPS required.

## Quick Start

### One-line setup (Linux / macOS)

```bash
git clone <repo-url> simple-vpn && cd simple-vpn && ./quickstart.sh
```

This clones, installs deps, builds, checks/installs WireGuard, and starts the daemon. You'll be prompted for your password (sudo) for VPN interface creation. The UI opens automatically in your browser.

### One-line setup (Windows)

```powershell
git clone <repo-url> simple-vpn; cd simple-vpn; .\quickstart.ps1
```

Run in PowerShell. You'll get a UAC prompt for admin privileges. Install [WireGuard for Windows](https://www.wireguard.com/install/) first if not already installed.

### Manual steps (if needed)

```bash
npm install      # install deps
npm run build    # compile TypeScript
npm start        # start daemon (needs root/admin)
npm stop         # stop daemon
npm run setup    # install + build + check WireGuard + start
```

**Requirements:** Node.js >= 20 LTS. Root/Administrator needed for VPN interface creation.

## How It Works

- **Anchor node** (game host): must be reachable on one UDP port from the internet (manual port-forward or UPnP). Acts as membership authority.
- **Player nodes**: install, paste invite code from anchor, paste reply back. Done.
- **Semi-mesh**: any node can optionally become a "listener" for direct peer-to-peer tunnels.

## Supported Platforms

- Linux (amd64/arm64)
- macOS (Intel + Apple Silicon)
- Windows (amd64)

## Architecture

- Backend: Node.js + TypeScript
- Data plane: vendored `wireguard-go` (userspace) driven via UAPI
- Frontend: vanilla JS + HTML (no framework)
- Crypto: Node.js built-in (Ed25519, X25519, SHA-256)

## Development

```bash
npm install      # install deps (ignore-scripts=true enforced)
npm run build    # compile TypeScript
npm test         # run test suite
```

## Security Notes

- `npm install` runs with `--ignore-scripts` (enforced via `.npmrc`)
- Prebuilt wireguard-go binaries verified against committed SHA-256 checksums
- Local web UI binds loopback only (127.0.0.1 + [::1])
- Session cookie + CSRF token auth on all API endpoints
- No telemetry; logs redact sensitive material

## Limitations

- Anchor behind CGNAT with no port-forward option = remote play unsupported
- IPv4-only overlay for MVP
- ≤10 members per network
- Unsigned builds (personal project scope — SmartScreen/Gatekeeper click-through expected)

## License

MIT. Bundled `wireguard-go` (MIT) and `wintun.dll` license texts included.
