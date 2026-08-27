// Auth & secrets test: password prompt state on auth failure, ssh-copy-id flow, encrypted password storage with a fake codec.
// usage: node test/auth.mjs [ssh-host]   (defaults to localhost; needs key login already working for the installKey check)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const host = process.argv[2] || 'localhost';
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostler-auth-'));
process.env.HOSTLER_CONFIG_DIR = cfgDir; // must be set before the server module is loaded (CONFIG_DIR is read at import)
const require = createRequire(import.meta.url);
const { startServer } = require('../dist/server/server.js');
let failures = 0;
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fake "keychain": reversible transform so we can assert what lands on disk
const codec = { backend: 'keychain', encrypt: (s) => 'ENC:' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };

let srv = await startServer({ port: 0, secretCodec: codec });
const connect = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${srv.token}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let n = 1; const pend = new Map(); const st = { state: null };
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (typeof m.id === 'number' && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } else if (m.ev === 'state') st.state = m; });
  const call = (op, params = {}) => new Promise((res, rej) => { const id = n++; pend.set(id, { res, rej }); ws.send(JSON.stringify({ ...params, id, op })); });
  return { ws, call, st };
};
const waitFor = async (pred, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (pred()) return true; await sleep(150); } return false; };

let { ws, call, st } = await connect();
await waitFor(() => st.state);
check(st.state.capabilities.secretStorage === 'keychain', 'capabilities report keychain secret storage');

// 1. auth failure -> needsPassword, no reconnect storm
const bad = await call('machine.add', { config: { name: 'authfail', transport: 'ssh', host, user: 'hostler-no-such-user', identityFile: '/nonexistent' } });
const getBad = () => st.state.machines.find((m) => m.config.id === bad.config.id);
check(await waitFor(() => getBad()?.needsPassword === true, 40000), `auth failure sets needsPassword (status=${getBad()?.status}, error=${getBad()?.error})`);
const log1 = await call('machine.log', { machineId: bad.config.id });
await sleep(3000);
const log2 = await call('machine.log', { machineId: bad.config.id });
check(!log2.some((l) => /reconnecting/.test(l)), 'no automatic reconnect loop after auth failure');
check(log1.length === log2.length, 'connection log is quiet while waiting for a password');
// wrong password via prompt -> still needsPassword; the password must not reach the UI
await call('machine.connect', { machineId: bad.config.id, password: 'definitely-wrong', remember: true });
await waitFor(() => getBad()?.status === 'connecting');
check(await waitFor(() => getBad()?.status === 'error' && getBad()?.needsPassword === true, 40000), 'wrong password -> prompt again');
check(getBad().config.password === undefined && getBad().config.passwordEnc === undefined, 'passwords never appear in the state sent to the UI');
await call('machine.remove', { machineId: bad.config.id });

// 2. remember=true stores the password encrypted on disk, never in plain text
const enc = await call('machine.add', { config: { name: 'enc', transport: 'ssh', host: '127.0.0.1', port: 1, password: 'S3cret!', savePassword: true }, connect: false });
await sleep(300);
const raw = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
check(!raw.includes('S3cret!'), 'plain password not written to config.json');
check(raw.includes('"passwordEnc": "ENC:'), 'encrypted password written to config.json');
const m = st.state.machines.find((x) => x.config.id === enc.config.id);
check(m.hasPassword === true && m.config.password === undefined, 'UI sees hasPassword=true but no secret');
// decrypt on next load
ws.close(); await srv.close();
srv = await startServer({ port: 0, secretCodec: codec });
({ ws, call, st } = await connect()); await waitFor(() => st.state);
check(st.state.machines.find((x) => x.config.name === 'enc')?.hasPassword === true, 'saved password decrypted and available after restart');
// headless (no codec): ciphertext preserved, not readable, cannot save new plain passwords
ws.close(); await srv.close();
srv = await startServer({ port: 0, secretCodec: null });
({ ws, call, st } = await connect()); await waitFor(() => st.state);
check(st.state.capabilities.secretStorage === 'none', 'browser mode reports no secret storage');
check(st.state.machines.find((x) => x.config.name === 'enc')?.hasPassword === false, 'without the keychain the saved password is unavailable (not silently plain)');
await call('machine.update', { machineId: st.state.machines.find((x) => x.config.name === 'enc').config.id, patch: { name: 'enc2' } });
await sleep(300);
check(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8').includes('"passwordEnc": "ENC:'), 'ciphertext survives a save in browser mode');
const pl = await call('machine.add', { config: { name: 'plain', transport: 'ssh', host: '127.0.0.1', port: 1, password: 'NoSave', savePassword: true }, connect: false });
await sleep(300);
const raw2 = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
check(!raw2.includes('NoSave') && st.state.machines.find((x) => x.config.id === pl.config.id).config.savePassword === false, 'browser mode refuses to persist passwords');

// 3. ssh-copy-id flow on a reachable host (key already works here, so this checks the mechanics + verification)
const good = await call('machine.add', { config: { name: 'keytest', transport: 'ssh', host } });
const getGood = () => st.state.machines.find((x) => x.config.id === good.config.id);
if (await waitFor(() => getGood()?.status === 'connected', 60000)) {
  check(['agent', 'publickey'].includes(getGood().authMethod), `authMethod reported: ${getGood().authMethod}`);
  const r = await call('machine.installKey', { machineId: good.config.id });
  check(r.verified === true, `installKey: added=${r.added} verified=${r.verified} identity=${r.identityFile}`);
  check(await waitFor(() => getGood()?.config.keyInstalled === true && getGood()?.config.identityFile === r.identityFile), 'machine config updated with the installed key');
  const ak = fs.readFileSync(path.join(os.homedir(), '.ssh', 'authorized_keys'), 'utf8').split('\n').filter((l) => l.trim() === r.publicKey.trim());
  check(ak.length === 1, 'public key present exactly once in authorized_keys (idempotent)');
} else {
  check(false, `could not connect to ${host}: ${getGood()?.error}`);
}
ws.close(); await srv.close();
console.log('FAILURES:', failures);
process.exit(failures ? 1 : 0);
