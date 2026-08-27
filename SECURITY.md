# Security

Hostler can run arbitrary commands on every machine you add, so it is designed to stay local:

- The control plane listens on `127.0.0.1` only and every websocket connection needs the token stored in
  `~/.config/hostler/token` (0600). Set `HOSTLER_NO_AUTH=1` only for local development.
- SSH host keys are trusted on first use and pinned in `~/.config/hostler/known_hosts.json`; a changed key aborts the connection.
- Passwords are kept in memory by default. The desktop app can remember them encrypted with the OS keychain
  (Electron `safeStorage`: macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). If no keyring is available (Electron's
  `basic_text` fallback) or Hostler runs in browser mode, remembering is disabled rather than degraded. Plain-text passwords
  are never written to disk and never sent to the UI or to remote helpers.
- The remote helper is a single Python file installed to `~/.hostler/` on the machine, listening on a `0600` unix socket
  owned by your user. It never opens a network port.
- Model traffic, agent authentication, MCP servers and permission prompts are handled by the agent CLIs themselves; Hostler
  does not intercept or store any of it.

To report a vulnerability, please open a private security advisory on GitHub rather than a public issue.
