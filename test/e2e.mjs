// End-to-end test: control plane (headless) + local machine + optional SSH machine, over the websocket protocol.
// usage: node test/e2e.mjs [ssh-host-alias]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-e2e-cfg-'));
const port = 17788 + Math.floor(Math.random() * 1000);
const sshHost = process.argv[2];
let failures = 0;
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.js')], { env: { ...process.env, HOSTLER_CONFIG_DIR: cfgDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d));
server.stderr.on('data', (d) => (serverOut += d));
for (let i = 0; i < 50 && !serverOut.includes('listening'); i++) await sleep(100);
check(serverOut.includes('listening'), 'control plane started: ' + serverOut.trim().split('\n')[0]);
const token = fs.readFileSync(path.join(cfgDir, 'token'), 'utf8').trim();

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let nextId = 1; const pending = new Map(); const events = [];
let state = null;
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (typeof m.id === 'number' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); return; }
  if (m.ev === 'state') state = m;
  events.push(m);
});
const call = (op, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ ...params, id, op })); });
const rpc = (machineId, rop, params = {}) => call('rpc', { machineId, rop, params });
const waitFor = async (pred, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (pred()) return true; await sleep(150); } return false; };

// unauthorized connection is rejected
await new Promise((res) => { const bad = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`); bad.once('error', () => { check(true, 'bad token rejected'); res(); }); bad.once('open', () => { check(false, 'bad token accepted'); res(); }); });

check(await waitFor(() => state && state.machines.length === 1 && state.machines[0].config.transport === 'local'), 'default local machine present');
check(await waitFor(() => state.machines[0].status === 'connected', 20000), `local machine connected (status=${state.machines[0].status} err=${state.machines[0].error || ''})`);
const local = state.machines[0].config.id;
check(await waitFor(() => state.machines[0].resources && state.machines[0].resources.mem_total > 0), 'resources streamed');
const hosts = await call('ssh.hosts');
check(Array.isArray(hosts), `ssh.hosts parsed ${hosts.length} host(s)`);

// session lifecycle through the ws protocol
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-e2e-ws-'));
const sess = await rpc(local, 'session.create', { spec: { type: 'custom', name: 'e2e', cwd: tmp, workspace: tmp, command: 'echo E2E_HELLO; sleep 2; echo E2E_BYE' } });
check(sess.id && sess.status === 'running', `session created ${sess.id}`);
const att = await rpc(local, 'session.attach', { session: sess.id, cols: 80, rows: 24 });
check(typeof att.scrollback === 'string', 'attach returned scrollback');
let out = '';
const collect = () => { for (const e of events) if (e.ev === 'output' && e.session === sess.id) out += Buffer.from(e.data, 'base64').toString(); events.length = 0; };
check(await waitFor(() => { collect(); return out.includes('E2E_BYE'); }, 15000), 'output streamed through control plane');
check(await waitFor(() => state.machines[0].sessions.find((s) => s.id === sess.id)?.status === 'exited'), 'session exit reflected in state');
check(state.workspaces.some((w) => w.path === tmp), 'workspace auto-registered from session');
const logs = await rpc(local, 'session.logs', { session: sess.id });
check(Buffer.from(logs.data, 'base64').toString().includes('E2E_HELLO'), 'logs via rpc');
const git = await rpc(local, 'git.status', { cwd: ROOT });
check(git.available && git.repo === true || git.repo === false, `git.status ok (repo=${git.repo})`);
const rescan = await rpc(local, 'tools.rescan');
check(rescan && 'claude' in rescan && 'git' in rescan, `tools.rescan ok (git=${rescan?.git ? 'found' : 'missing'}, agents=${['claude', 'codex', 'opencode'].filter((t) => rescan?.[t]).join(',') || 'none'})`);
const hist = await rpc(local, 'history.list', { cwd: ROOT });
check(Array.isArray(hist) && hist.every((h) => h.session_id && h.type && h.cwd === ROOT), `history.list ok (${Array.isArray(hist) ? hist.length : '?'} past conversation(s) for this repo)`);

// token usage: a report over whatever transcripts this machine happens to have, and its cache
const t0 = Date.now();
const usage = await rpc(local, 'usage.report', { days: 30, force: true });
const cold = Date.now() - t0;
const hours = Object.keys(usage.hours || {});
check(hours.every((h) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(h)), `usage.report buckets are UTC hours (${hours.length} bucket(s), ${usage.files} transcript(s), ${cold}ms cold)`);
check(Object.values(usage.hours).every((slots) => Object.entries(slots).every(([k, v]) => k.includes(':') && v.length === 6 && v.every((n) => Number.isFinite(n) && n >= 0))),
  'usage.report totals are six non-negative counters keyed <kind>:<model>');
check(usage.sessions.every((s) => s.id && s.kind && s.messages > 0), `usage.report lists ${usage.sessions.length} conversation(s)`);
const t1 = Date.now();
const again = await rpc(local, 'usage.report', { days: 30, force: true });
check(again.scanned === 0 && Date.now() - t1 <= Math.max(200, cold), `unchanged transcripts are not rescanned (${again.scanned} rescanned, ${Date.now() - t1}ms warm)`);

// chat: a shell session has no transcript to read, and says so rather than failing
const chatShell = await rpc(local, 'chat.messages', { session: sess.id });
check(Array.isArray(chatShell.messages) && chatShell.messages.length === 0 && !!chatShell.error, `chat.messages on a session with no agent transcript: ${chatShell.error}`);
await rpc(local, 'chat.messages', { kind: 'claude', path: '/etc/passwd' }).then(
  () => check(false, 'chat.messages refuses a path outside the harness session stores'),
  (e) => check(/transcript path/.test(e.message), `chat.messages refuses a path outside the harness session stores (${e.message})`));
const ls = await rpc(local, 'fs.list', { path: '~' });
check(ls.path === os.homedir(), 'fs.list ~');
await rpc(local, 'session.remove', { session: sess.id });
check(await waitFor(() => !state.machines[0].sessions.find((s) => s.id === sess.id)), 'session removed');

// machine CRUD
const m2 = await call('machine.add', { config: { name: 'unreachable', transport: 'ssh', host: '127.0.0.1', port: 1, user: 'nobody' }, connect: true });
check(m2.config.name === 'unreachable', 'machine.add');
check(await waitFor(() => state.machines.find((m) => m.config.id === m2.config.id)?.status === 'error', 20000), 'unreachable machine reports error: ' + state.machines.find((m) => m.config.id === m2.config.id)?.error);
await call('machine.remove', { machineId: m2.config.id });
check(await waitFor(() => !state.machines.find((m) => m.config.id === m2.config.id)), 'machine.remove');

if (sshHost) {
  console.log(`--- ssh machine ${sshHost}`);
  const m3 = await call('machine.add', { config: { name: 'ssh-test', transport: 'ssh', host: sshHost }, connect: true });
  const get = () => state.machines.find((m) => m.config.id === m3.config.id);
  check(await waitFor(() => get()?.status === 'connected' || get()?.status === 'error', 60000), `ssh machine status=${get()?.status} ${get()?.error || ''}`);
  const log = await call('machine.log', { machineId: m3.config.id });
  console.log('     log:', log.join(' | '));
  if (get()?.status === 'connected') {
    check(get().hello?.version, `helper hello over ssh: v${get().hello?.version} on ${get().hello?.hostname}`);
    const s3 = await rpc(m3.config.id, 'session.create', { spec: { type: 'shell', name: 'ssh-shell', cwd: os.homedir() } });
    await rpc(m3.config.id, 'session.attach', { session: s3.id, cols: 80, rows: 24 });
    await sleep(2500);
    await rpc(m3.config.id, 'session.input', { session: s3.id, data: Buffer.from('echo SSH_$((1+1))\n').toString('base64') });
    let o = '';
    check(await waitFor(() => { for (const e of events) if (e.ev === 'output' && e.session === s3.id) o += Buffer.from(e.data, 'base64').toString(); events.length = 0; return o.includes('SSH_2\r\n'); }, 10000), 'pty over ssh works');
    await rpc(m3.config.id, 'session.signal', { session: s3.id, signal: 'HUP' });
    check(await waitFor(() => get().sessions.find((s) => s.id === s3.id)?.status === 'exited'), 'ssh session exit observed');
    await rpc(m3.config.id, 'session.remove', { session: s3.id });
    await call('machine.disconnect', { machineId: m3.config.id });
    check(await waitFor(() => get()?.status === 'disconnected'), 'ssh disconnect');
  }
  await call('machine.remove', { machineId: m3.config.id });
}

ws.close();
server.kill('SIGTERM');
await sleep(500);
console.log('FAILURES:', failures);
if (failures) console.log(serverOut.slice(-2000));
process.exit(failures ? 1 : 0);
