# Contributing

Thanks for helping! The codebase is small and split by process:

| Directory   | What                                                        | Language |
|-------------|-------------------------------------------------------------|----------|
| `helper/`   | remote helper daemon (single file, stdlib only, Python ≥ 3.6) | Python   |
| `server/`   | local control plane: ssh2 transport, helper client, ws API  | TypeScript (Node) |
| `ui/`       | React + xterm.js interface                                  | TypeScript |
| `electron/` | desktop shell                                               | TypeScript |
| `shared/`   | types shared by server, electron and UI                     | TypeScript |
| `test/`     | end-to-end tests over the websocket protocol                | JavaScript |

## Development

```bash
npm install
npm run dev              # hot reload: control plane + vite + electron
HOSTLER_DEMO=1 npm run dev:web   # UI with synthetic machines, no SSH needed
```

## Tests

```bash
npm run typecheck
python3 helper/test_introspect.py     # transcript parsers, synthetic fixtures
python3 helper/test_helper.py         # isolated helper: PTY, attribution, git, fs, discovery
npm run build:server && node test/e2e.mjs localhost   # needs `ssh localhost` with key auth
node test/auth.mjs localhost
```

CI runs all of the above on Ubuntu (see `.github/workflows/ci.yml`).

## Guidelines

- The helper must stay a single stdlib-only file and keep working on Python 3.6 (Jetson JetPack 4).
- Never persist secrets in plain text; never send them to the UI.
- Requests carry the request id in `id`; use `session`, `machineId`, `workspaceId` for entity ids.
- Prefer small PRs with a test (fixture-based tests for parsers, e2e for protocol changes).
