# Security Policy

Remote Shell Mobile intentionally provides remote command execution on the host Mac. Treat every reachable client as capable of acting with the permissions of the macOS user running the service.

## Supported versions

Security fixes are provided for the latest release on the default branch. Pre-release and development snapshots may change without compatibility guarantees.

## Safe deployment baseline

- Keep both the Node service and ttyd bound to `127.0.0.1`.
- Expose them only through Tailscale Serve inside a controlled tailnet.
- Restrict access with Tailscale Grants/ACLs to trusted users and devices.
- Never publish either port through a router, public reverse proxy, Tailscale Funnel, or unrestricted cloud tunnel.
- Run the service as a non-administrator macOS user with access only to the intended project root.
- Keep `.env.local`, `.runtime`, logs, CLI credentials, and shell history out of Git.

Same-origin checks and project-root validation reduce accidental misuse, but they are not authentication controls.

## Reporting a vulnerability

Use the GitHub repository's private **Report a vulnerability** flow when available. Please include the affected version, deployment topology, reproduction steps, and impact. Do not include real credentials, private source code, terminal history, or model conversation content.

Please avoid opening a public issue with working exploit details until a fix is available.
