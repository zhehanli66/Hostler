# Security

Hostler can run arbitrary commands on every machine you add, so it is designed to stay local:

- The control plane listens on `127.0.0.1` only and every websocket connection needs the token stored in
  `~/.config/hostler/token` (0600). Set `HOSTLER_NO_AUTH=1` only for local development.
- SSH host keys are trusted on first use and pinned in `~/.config/hostler/known_hosts.json`; a changed key aborts the connection
  and stops automatic reconnects until you remove the pin. A `ProxyJump` bastion is authenticated with your agent/keys only —
  the password you enter for a machine is never offered to the jump host, and keyboard-interactive prompts that are not
  password prompts (verification codes) are left empty.
- Passwords are kept in memory by default. The desktop app can remember them encrypted with the OS keychain
  (Electron `safeStorage`: macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). If no keyring is available (Electron's
  `basic_text` fallback) or Hostler runs in browser mode, remembering is disabled rather than degraded. Plain-text passwords
  are never written to disk and never sent to the UI or to remote helpers.
- The remote helper is a single Python file installed to `~/.hostler/` on the machine, listening on a `0600` unix socket
  owned by your user. It never opens a network port. On shared machines the socket may have to live on local disk
  (`/tmp/hostler-<uid>/`, or `$XDG_RUNTIME_DIR`); the helper and every client refuse a socket or directory that is not
  owned by your user or is writable by others, so another local user cannot plant an impostor there.
- Session logs (`~/.hostler/logs/`) hold the full terminal output of a session and are deleted when the session is removed.
- Model traffic, agent authentication, MCP servers and permission prompts are handled by the agent CLIs themselves; Hostler
  does not intercept or store any of it.

To report a vulnerability, please open a private security advisory on GitHub rather than a public issue.
