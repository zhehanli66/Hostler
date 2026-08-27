import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { AppState, MachineConfig, MachineState, WorkspaceConfig } from '../shared/types';
import { loadConfig, saveConfig, newId, secretBackend, type ConfigData } from './config';
import { HelperClient } from './helperClient';
import { makeTransport, helperSource, ensureLocalKey, SshTransport, type Transport } from './transport';
import { demoCluster, demoHistory, demoMachines, tickDemo } from './demo';

const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export class MachineConn extends EventEmitter {
  state: MachineState;
  transport: Transport | null = null;
  client: HelperClient | null = null;
  wantConnected = false;
  private backoff = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  /** helper session id -> set of ws client ids that want its output */
  attached = new Map<string, Set<string>>();
  password?: string;
  logLines: string[] = [];

  constructor(public config: MachineConfig) {
    super();
    this.state = { config, status: 'disconnected', sessions: [], discovered: [], helperVersionLocal: safeHelperVersion() };
  }

  get id() { return this.config.id; }

  private setStatus(status: MachineState['status'], error?: string | null) {
    this.state.status = status;
    this.state.error = error ?? null;
    this.state.hasPassword = !!(this.password || this.config.password);
    this.emit('change');
  }

  private note(m: string) {
    log(`[${this.config.name}] ${m}`);
    this.logLines.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
    if (this.logLines.length > 200) this.logLines.shift();
  }

  async connect(password?: string, remember?: boolean) {
    // a password is only persisted once the machine has accepted it (see below) — never a wrong one
    const persistPassword = password !== undefined && !!remember && secretBackend() !== 'none';
    if (password !== undefined) {
      this.password = password;
      this.state.needsPassword = false;
    }
    this.wantConnected = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connecting || this.state.status === 'connected') return;
    this.connecting = true;
    try {
      this.setStatus('connecting');
      this.transport = makeTransport(this.config, this.password);
      await this.transport.open((m) => this.note(m));
      if (persistPassword && this.password !== undefined) {
        this.config.password = this.password;
        this.config.savePassword = true;
        this.emit('config-changed');
      }
      this.setStatus('deploying');
      const dep = await this.transport.deploy((m) => this.note(m));
      if (!dep.running) throw new Error(dep.error || 'helper failed to start');
      this.state.helperUpgradePending = dep.upgrade_pending || null;
      this.state.authMethod = this.transport instanceof SshTransport ? this.transport.authMethod : 'local';
      this.state.needsPassword = false;
      this.state.hostKeyMismatch = false;
      const stream = await this.transport.connectHelper((m) => this.note(m));
      const client = new HelperClient(stream);
      this.client = client;
      client.on('event', (ev) => this.onHelperEvent(ev));
      client.on('close', (err) => this.onClose(err));
      const hello = await client.call('hello', { client: `hostler@${os.hostname()}` }, 15000);
      this.state.hello = hello;
      const snap = await client.call('subscribe', {}, 15000);
      this.applyState(snap);
      this.state.connectedAt = Date.now();
      this.backoff = 2000;
      this.setStatus('connected');
      this.note(`connected: helper ${hello.version} on ${hello.hostname} (${hello.user})`);
      // re-attach sessions ws clients were watching
      for (const sid of this.attached.keys()) client.call('session.attach', { session: sid }).catch(() => undefined);
    } catch (e: any) {
      this.note(`connect failed: ${e.message}`);
      this.cleanup();
      if (e.authFailed) {
        // wrong/missing credentials: do not hammer the server, ask the user instead
        const hadPassword = this.password !== undefined || !!this.config.password;
        this.state.needsPassword = true;
        this.password = undefined;
        this.setStatus('error', hadPassword ? e.message : 'authentication failed — a password is needed');
      } else if (e.hostKeyMismatch) {
        // a changed host key is a decision for the user, not something to retry every 30 s
        this.state.hostKeyMismatch = true;
        this.setStatus('error', e.message);
      } else {
        this.setStatus('error', e.message);
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect() {
    if (!this.wantConnected || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.note(`reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private onClose(err?: Error) {
    if (!this.client) return;
    this.note(`helper connection closed${err ? ': ' + err.message : ''}`);
    this.cleanup();
    this.setStatus(this.wantConnected ? 'error' : 'disconnected', err?.message || (this.wantConnected ? 'connection lost' : null));
    this.scheduleReconnect();
  }

  private cleanup() {
    const c = this.client; this.client = null;
    try { c?.close(); } catch { /* ignore */ }
    try { this.transport?.close(); } catch { /* ignore */ }
    this.transport = null;
  }

  disconnect() {
    this.wantConnected = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.cleanup();
    this.state.hello = null;
    this.setStatus('disconnected');
  }

  private applyState(snap: any) {
    this.state.resources = snap.resources;
    const r = snap.resources;
    if (r) {
      const g = r.gpus?.[0];
      const h = this.state.history || (this.state.history = []);
      h.push({ t: Date.now(), cpu: r.cpu_pct, mem: r.mem_total ? (100 * r.mem_used) / r.mem_total : 0, gpu: g?.util ?? 0, vram: g && g.mem_total ? (100 * g.mem_used) / g.mem_total : 0 });
      if (h.length > 120) h.splice(0, h.length - 120);
    }
    this.state.sessions = snap.sessions || [];
    this.state.discovered = snap.discovered || [];
    if (snap.host) this.state.hello = snap.host;
    this.state.lastUpdate = Date.now();
  }

  private onHelperEvent(ev: any) {
    switch (ev.ev) {
      case 'state':
        this.applyState(ev);
        this.emit('change');
        break;
      case 'output':
        this.emit('output', ev.session, ev.data);
        break;
      case 'session.exit':
      case 'session.created':
      case 'session.removed':
        this.emit('session-event', ev);
        if (ev.ev === 'session.removed') this.attached.delete(ev.id);
        break;
      default:
        break;
    }
  }

  async rpc(op: string, params: Record<string, any> = {}, timeoutMs?: number) {
    if (!this.client) throw new Error(`${this.config.name} is not connected`);
    return this.client.call(op, params, timeoutMs);
  }

  async attach(wsId: string, session: string, cols?: number, rows?: number) {
    let set = this.attached.get(session);
    const first = !set;
    if (!set) { set = new Set(); this.attached.set(session, set); }
    set.add(wsId);
    // always call attach so the client gets scrollback; helper de-duplicates subscribers per connection
    return this.rpc('session.attach', { session, cols, rows });
  }

  async detach(wsId: string, session?: string) {
    const targets = session ? [session] : [...this.attached.keys()];
    for (const sid of targets) {
      const set = this.attached.get(sid);
      if (!set) continue;
      set.delete(wsId);
      if (set.size === 0) {
        this.attached.delete(sid);
        if (this.client) this.rpc('session.detach', { session: sid }).catch(() => undefined);
      }
    }
  }

  wants(session: string, wsId: string) {
    return this.attached.get(session)?.has(wsId) ?? false;
  }

  /** ssh-copy-id: install the local public key on this machine, verify key auth, then forget the password. */
  async installKey() {
    if (this.config.transport !== 'ssh') throw new Error('only for SSH machines');
    const t = this.transport;
    if (!(t instanceof SshTransport) || this.state.status !== 'connected') throw new Error('connect to the machine first');
    const key = ensureLocalKey();
    if (key.generated) this.note(`generated local key ${key.privateKey}`);
    const res = await t.installPublicKey(key.publicKeyLine);
    this.note(`public key ${res.toLowerCase()} on remote authorized_keys`);
    const verified = await t.testKeyAuth(key.privateKey, (m) => this.note(m));
    const reason = verified ? '' : await t.keyAuthDiagnosis().catch(() => '');
    if (reason) this.note(`key auth refused: ${reason}`);
    if (verified) {
      this.password = undefined;
      delete this.config.password;
      delete this.config.passwordEnc;
      this.config.savePassword = false;
      this.config.identityFile = key.privateKey;
      this.config.keyInstalled = true;
      this.state.authMethod = 'publickey';
      this.emit('config-changed');
      this.note('key login verified; password forgotten');
    }
    this.setStatus(this.state.status);
    return { publicKey: key.publicKeyLine, identityFile: key.privateKey, added: res === 'ADDED', verified, reason };
  }
}

function appVersion(): string {
  for (const c of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', '..', 'package.json')]) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')).version; } catch { /* next */ }
  }
  return '0.0.0';
}

function safeHelperVersion() {
  try { return helperSource().version; } catch { return undefined; }
}

export class MachineManager extends EventEmitter {
  cfg: ConfigData;
  machines = new Map<string, MachineConn>();
  private changeTimer: NodeJS.Timeout | null = null;

  demo = !!process.env.HOSTLER_DEMO;

  constructor() {
    super();
    this.cfg = loadConfig();
    if (this.demo) {
      const d = demoMachines();
      for (const st of d.machines) {
        const conn = new MachineConn(st.config);
        conn.state = st;
        conn.connect = async () => undefined;
        conn.rpc = async (op: string, params: Record<string, any> = {}) => {
          if (op === 'history.list') return demoHistory(params.cwd || '/home/dev/src/vision-pipeline');
          if (op === 'cluster.status') return demoCluster();
          throw new Error('demo mode: this machine is not real');
        };
        this.machines.set(st.config.id, conn);
      }
      this.cfg.workspaces = d.workspaces;
      setInterval(() => { for (const c of this.machines.values()) tickDemo(c.state); this.emit('change'); }, 2000);
      return;
    }
    if (this.cfg.machines.length === 0) {
      this.cfg.machines.push({ id: 'local', name: 'This computer', transport: 'local', autoConnect: true, createdAt: Date.now() });
      saveConfig(this.cfg);
    }
    for (const m of this.cfg.machines) this.register(m);
  }

  private register(m: MachineConfig) {
    const conn = new MachineConn(m);
    conn.on('change', () => this.scheduleChange());
    conn.on('output', (session: string, data: string) => this.emit('output', conn.id, session, data));
    conn.on('session-event', (ev: any) => { this.emit('session-event', conn.id, ev); this.scheduleChange(); });
    conn.on('config-changed', () => { saveConfig(this.cfg); this.scheduleChange(); });
    this.machines.set(m.id, conn);
    return conn;
  }

  private scheduleChange() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('change'); }, 150);
  }

  autoConnect() {
    for (const c of this.machines.values()) if (c.config.autoConnect !== false) c.connect().catch(() => undefined);
  }

  get(id: string) {
    const c = this.machines.get(id);
    if (!c) throw new Error('unknown machine ' + id);
    return c;
  }

  getState(): AppState {
    return {
      version: appVersion(),
      // secrets never leave the control plane: the UI only learns whether a password exists
      machines: [...this.machines.values()].map((c) => {
        const { password, passwordEnc, ...config } = c.config;
        return { ...c.state, config, hasPassword: !!(c.password || password) };
      }),
      workspaces: this.cfg.workspaces,
      capabilities: { secretStorage: secretBackend(), desktop: !!process.versions.electron },
    };
  }

  addMachine(input: Partial<MachineConfig>): MachineConn {
    const cfg: MachineConfig = {
      id: newId('m_'), name: (input.name || input.host || 'machine').trim(), transport: input.transport || 'ssh',
      host: input.host?.trim() || undefined, port: input.port || undefined, user: input.user?.trim() || undefined,
      identityFile: input.identityFile?.trim() || undefined, password: input.password || undefined, savePassword: !!input.savePassword && secretBackend() !== 'none',
      proxyJump: input.proxyJump?.trim() || undefined, pythonPath: input.pythonPath?.trim() || undefined,
      autoConnect: input.autoConnect !== false, color: input.color, createdAt: Date.now(),
    };
    this.cfg.machines.push(cfg);
    saveConfig(this.cfg);
    const conn = this.register(cfg);
    if (cfg.password) conn.password = cfg.password;
    this.scheduleChange();
    return conn;
  }

  updateMachine(id: string, patch: Partial<MachineConfig>) {
    const conn = this.get(id);
    const { id: _ignore, createdAt: _c, passwordEnc: _pe, keyInstalled: _ki, ...rest } = patch as any;
    if (rest.savePassword && secretBackend() === 'none') rest.savePassword = false;
    Object.assign(conn.config, rest);
    if (rest.savePassword === false) delete conn.config.passwordEnc;
    for (const k of Object.keys(rest)) if ((rest as any)[k] === '' || (rest as any)[k] === null) delete (conn.config as any)[k];
    if (rest.password) conn.password = rest.password;
    conn.state.config = conn.config;
    saveConfig(this.cfg);
    this.scheduleChange();
    return conn;
  }

  removeMachine(id: string) {
    const conn = this.get(id);
    conn.disconnect();
    this.machines.delete(id);
    this.cfg.machines = this.cfg.machines.filter((m) => m.id !== id);
    this.cfg.workspaces = this.cfg.workspaces.filter((w) => w.machineId !== id);
    saveConfig(this.cfg);
    this.emit('machine-removed', id);
    this.scheduleChange();
  }

  addWorkspace(machineId: string, p: string, name?: string): WorkspaceConfig {
    this.get(machineId);
    const existing = this.cfg.workspaces.find((w) => w.machineId === machineId && w.path === p);
    if (existing) return existing;
    const ws: WorkspaceConfig = { id: newId('w_'), machineId, path: p, name: name || p.split('/').filter(Boolean).pop() || p, createdAt: Date.now() };
    this.cfg.workspaces.push(ws);
    saveConfig(this.cfg);
    this.scheduleChange();
    return ws;
  }

  removeWorkspace(id: string) {
    this.cfg.workspaces = this.cfg.workspaces.filter((w) => w.id !== id);
    saveConfig(this.cfg);
    this.scheduleChange();
  }

  shutdown() {
    for (const c of this.machines.values()) c.disconnect();
  }
}
