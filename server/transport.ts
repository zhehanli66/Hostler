import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { Client as SshClient, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { MachineConfig } from '../shared/types';
import { findSshHost, defaultIdentityFiles } from './sshconfig';
import { loadKnownHosts, saveKnownHosts } from './config';

export interface DeployResult { running: boolean; version?: string; pid?: number; upgrade_pending?: string; reason?: string; error?: string }

export interface Transport {
  /** Establish the underlying connection (ssh handshake). No-op for local. */
  open(log: (m: string) => void): Promise<void>;
  /** Make sure the helper file is up to date and the daemon runs. */
  deploy(log: (m: string) => void): Promise<DeployResult>;
  /** Open a duplex stream to the helper's unix socket. */
  connectHelper(log: (m: string) => void): Promise<Duplex>;
  close(): void;
}

// ---------------------------------------------------------------- helper file

export function helperFilePath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'helper', 'hostler_helper.py'), // dist/server -> repo root
    path.join(__dirname, '..', 'helper', 'hostler_helper.py'),       // server/ (tsx dev)
    path.join(process.cwd(), 'helper', 'hostler_helper.py'),
  ];
  if ((process as any).resourcesPath) candidates.unshift(path.join((process as any).resourcesPath, 'helper', 'hostler_helper.py'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('helper/hostler_helper.py not found');
}

let helperCache: { text: string; version: string; sha: string } | null = null;
export function helperSource() {
  if (!helperCache) {
    const text = fs.readFileSync(helperFilePath(), 'utf8');
    const version = text.match(/^VERSION\s*=\s*"([^"]+)"/m)?.[1] || '0';
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    helperCache = { text, version, sha };
  }
  return helperCache;
}

const REMOTE_DIR = '.hostler';
const REMOTE_FILE = 'hostler_helper.py';

// ---------------------------------------------------------------- local

export class LocalTransport implements Transport {
  private sock = path.join(process.env.HOSTLER_DIR || path.join(os.homedir(), REMOTE_DIR), 'helper.sock');
  private file = path.join(process.env.HOSTLER_DIR || path.join(os.homedir(), REMOTE_DIR), REMOTE_FILE);
  constructor(private cfg: MachineConfig) {}

  async open() { /* nothing */ }

  async deploy(log: (m: string) => void): Promise<DeployResult> {
    const src = helperSource();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let current = '';
    try { current = fs.readFileSync(this.file, 'utf8'); } catch { /* missing */ }
    if (current !== src.text) {
      fs.writeFileSync(this.file, src.text, { mode: 0o600 });
      log(`helper ${src.version} installed to ${this.file}`);
    }
    const py = this.cfg.pythonPath || 'python3';
    const out = await runLocal(py, [this.file, 'ensure']);
    log(`ensure: ${out.trim()}`);
    return parseDeploy(out);
  }

  connectHelper(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.sock);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  close() { /* nothing persistent */ }
}

function runLocal(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err || out}`))));
  });
}

function parseDeploy(out: string): DeployResult {
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error('unexpected helper output: ' + out.slice(-400));
  return JSON.parse(line);
}

// ---------------------------------------------------------------- ssh

/** Returns the local key pair to offer to remote machines, generating an ed25519 key if none exists. */
export function ensureLocalKey(): { privateKey: string; publicKeyLine: string; generated: boolean } {
  const dir = path.join(os.homedir(), '.ssh');
  for (const k of defaultIdentityFiles()) {
    if (fs.existsSync(k + '.pub')) return { privateKey: k, publicKeyLine: fs.readFileSync(k + '.pub', 'utf8').trim(), generated: false };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const priv = path.join(dir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', priv, '-C', `hostler@${os.hostname()}`], { stdio: 'ignore' });
  return { privateKey: priv, publicKeyLine: fs.readFileSync(priv + '.pub', 'utf8').trim(), generated: true };
}

export class SshTransport implements Transport {
  private client: SshClient | null = null;
  private jump: SshClient | null = null;
  private home = '';
  private python = '';
  /** auth method that succeeded for the target host */
  authMethod: string | null = null;
  constructor(private cfg: MachineConfig, private password?: string) {}

  private resolved() {
    const alias = this.cfg.host || this.cfg.name;
    const entry = findSshHost(alias);
    return {
      host: this.cfg.host && (!entry || this.cfg.host !== entry.host) ? this.cfg.host : entry?.hostName || alias,
      port: this.cfg.port || entry?.port || 22,
      user: this.cfg.user || entry?.user || os.userInfo().username,
      identityFile: this.cfg.identityFile || entry?.identityFile,
      proxyJump: this.cfg.proxyJump || entry?.proxyJump,
    };
  }

  async open(log: (m: string) => void) {
    const r = this.resolved();
    let sock: Duplex | undefined;
    if (r.proxyJump) {
      log(`connecting via jump host ${r.proxyJump}`);
      const jumpEntry = findSshHost(r.proxyJump);
      const m = r.proxyJump.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
      const jumpCfg = {
        host: jumpEntry?.hostName || m?.[2] || r.proxyJump,
        port: m?.[3] ? parseInt(m[3], 10) : jumpEntry?.port || 22,
        user: m?.[1] || jumpEntry?.user || os.userInfo().username,
        identityFile: jumpEntry?.identityFile,
      };
      this.jump = await this.connectClient(jumpCfg, log, this.password);
      sock = await new Promise<Duplex>((resolve, reject) =>
        this.jump!.forwardOut('127.0.0.1', 0, r.host, r.port, (err, stream) => (err ? reject(err) : resolve(stream))));
    }
    log(`ssh ${r.user}@${r.host}:${r.port}`);
    this.client = await this.connectClient(r, log, this.password, sock, { track: true });
  }

  /** Append a public key line to ~/.ssh/authorized_keys on the remote (ssh-copy-id equivalent). */
  async installPublicKey(publicKeyLine: string) {
    const b64 = Buffer.from(publicKeyLine + '\n').toString('base64');
    const script = `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
      `K="$(printf %s ${b64} | base64 -d)" && if grep -qxF "$K" ~/.ssh/authorized_keys; then echo EXISTS; else printf '%s\n' "$K" >> ~/.ssh/authorized_keys && echo ADDED; fi`;
    const r = await this.exec(script, 20000);
    if (r.code !== 0) throw new Error(`could not install key: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  }

  /** Open a throw-away connection authenticating with this key only; resolves true if the server accepts it. */
  async testKeyAuth(privateKey: string, log: (m: string) => void): Promise<boolean> {
    const r = this.resolved();
    let sock: Duplex | undefined;
    if (this.jump) sock = await new Promise<Duplex>((resolve, reject) => this.jump!.forwardOut('127.0.0.1', 0, r.host, r.port, (err, stream) => (err ? reject(err) : resolve(stream))));
    try {
      const c = await this.connectClient(r, log, undefined, sock, { onlyKey: privateKey });
      c.end();
      return true;
    } catch (e: any) {
      log(`key auth test failed: ${e.message}`);
      return false;
    }
  }

  private connectClient(r: { host: string; port: number; user: string; identityFile?: string }, log: (m: string) => void, password?: string, sock?: Duplex, opts: { onlyKey?: string; track?: boolean } = {}): Promise<SshClient> {
    return new Promise((resolve, reject) => {
      const client = new SshClient();
      const keys = (opts.onlyKey ? [opts.onlyKey] : [r.identityFile, ...defaultIdentityFiles()]).filter((k, i, a): k is string => !!k && a.indexOf(k) === i && fs.existsSync(k));
      const methods: any[] = [];
      if (process.env.SSH_AUTH_SOCK && !opts.onlyKey) methods.push({ type: 'agent', username: r.user, agent: process.env.SSH_AUTH_SOCK });
      for (const k of keys) {
        try {
          methods.push({ type: 'publickey', username: r.user, key: fs.readFileSync(k) });
        } catch { /* skip */ }
      }
      if (password && !opts.onlyKey) {
        methods.push({ type: 'password', username: r.user, password });
        methods.push({
          type: 'keyboard-interactive', username: r.user,
          prompt: (_n: string, _i: string, _l: string, prompts: any[], finish: (a: string[]) => void) => finish(prompts.map(() => password)),
        });
      }
      let idx = 0;
      const known = loadKnownHosts();
      const hostKey = `${r.host}:${r.port}`;
      const conf: ConnectConfig = {
        host: r.host, port: r.port, username: r.user, sock: sock as any,
        readyTimeout: 25000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (hash: any, cb: (ok: boolean) => void) => {
          const h = typeof hash === 'string' ? hash : Buffer.from(hash).toString('base64');
          if (!known[hostKey]) { known[hostKey] = h; saveKnownHosts(known); log(`host key for ${hostKey} recorded (sha256:${h.slice(0, 16)}…)`); cb(true); return; }
          if (known[hostKey] === h) { cb(true); return; }
          log(`HOST KEY MISMATCH for ${hostKey}! remove it from known_hosts.json in the config dir if this is expected`);
          cb(false);
        },
        authHandler: (_methodsLeft: any, _partial: any, cb: (m: any) => void) => {
          if (idx >= methods.length) { cb(false); return; }
          const m = methods[idx++];
          log(`auth: trying ${m.type}`);
          if (opts.track) this.authMethod = m.type;
          cb(m);
        },
      };
      client.once('ready', () => resolve(client));
      client.once('error', (e) => {
        const auth = /authentication methods failed|auth/i.test(e.message) || (e as any).level === 'client-authentication';
        const err: any = new Error(`ssh: ${e.message}${methods.length === 0 ? ' (no ssh-agent, keys or password available)' : ''}`);
        err.authFailed = auth;
        reject(err);
      });
      client.connect(conf);
    });
  }

  exec(cmd: string, timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      const timer = setTimeout(() => reject(new Error(`ssh exec timed out: ${cmd.slice(0, 60)}`)), timeoutMs);
      this.client.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        let stdout = '', stderr = '';
        stream.on('data', (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        stream.on('close', (code: number) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }); });
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => this.client!.sftp((err, s) => (err ? reject(err) : resolve(s))));
  }

  async deploy(log: (m: string) => void): Promise<DeployResult> {
    const src = helperSource();
    const probe = await this.exec('echo "HOME=$HOME"; for p in ' + (this.cfg.pythonPath ? `"${this.cfg.pythonPath}" ` : '') + 'python3 python; do if command -v "$p" >/dev/null 2>&1; then echo "PY=$(command -v "$p")"; break; fi; done; uname -m');
    this.home = probe.stdout.match(/^HOME=(.*)$/m)?.[1]?.trim() || '';
    this.python = probe.stdout.match(/^PY=(.*)$/m)?.[1]?.trim() || '';
    if (!this.home) throw new Error('could not determine remote $HOME');
    if (!this.python) throw new Error('python3 not found on remote (install python3, or set pythonPath in the machine settings)');
    const remoteDir = `${this.home}/${REMOTE_DIR}`;
    const remoteFile = `${remoteDir}/${REMOTE_FILE}`;
    const ver = await this.exec(`"${this.python}" "${remoteFile}" version 2>/dev/null; echo; sha256sum "${remoteFile}" 2>/dev/null | cut -d' ' -f1`);
    const [remoteVersion, remoteSha] = ver.stdout.trim().split(/\s+/);
    if (remoteSha !== src.sha) {
      log(`uploading helper ${src.version} (remote: ${remoteVersion || 'none'})`);
      await this.exec(`mkdir -p "${remoteDir}" && chmod 700 "${remoteDir}"`);
      const sftp = await this.sftp();
      await new Promise<void>((resolve, reject) => sftp.writeFile(remoteFile, src.text, { mode: 0o600 } as any, (e: any) => (e ? reject(e) : resolve())));
      sftp.end();
    }
    const ens = await this.exec(`"${this.python}" "${remoteFile}" ensure`, 40000);
    if (ens.code !== 0 && !ens.stdout.includes('{')) throw new Error(`helper ensure failed: ${ens.stderr || ens.stdout}`);
    log(`ensure: ${ens.stdout.trim().split('\n').pop()}`);
    return parseDeploy(ens.stdout);
  }

  connectHelper(log: (m: string) => void): Promise<Duplex> {
    const sockPath = `${this.home}/${REMOTE_DIR}/helper.sock`;
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('not connected'));
      const c: any = this.client;
      c.openssh_forwardOutStreamLocal(sockPath, (err: Error | undefined, stream: Duplex) => {
        if (!err) return resolve(stream);
        log(`streamlocal forwarding unavailable (${err.message}); falling back to relay`);
        this.client!.exec(`"${this.python}" "${this.home}/${REMOTE_DIR}/${REMOTE_FILE}" relay`, (e2, ch) => {
          if (e2) return reject(e2);
          ch.stderr.on('data', (d: Buffer) => log('relay: ' + d.toString().trim()));
          resolve(ch);
        });
      });
    });
  }

  close() {
    try { this.client?.end(); } catch { /* ignore */ }
    try { this.jump?.end(); } catch { /* ignore */ }
    this.client = null;
    this.jump = null;
  }
}

export function makeTransport(cfg: MachineConfig, password?: string): Transport {
  return cfg.transport === 'local' ? new LocalTransport(cfg) : new SshTransport(cfg, password ?? cfg.password);
}
