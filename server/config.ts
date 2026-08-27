import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { MachineConfig, SecretBackend, WorkspaceConfig } from '../shared/types';

/** Encrypts secrets at rest. Provided by the Electron shell (safeStorage); absent in browser/headless mode. */
export interface SecretCodec { backend: SecretBackend; encrypt(plain: string): string; decrypt(enc: string): string }
let codec: SecretCodec | null = null;
export function setSecretCodec(c: SecretCodec | null) { codec = c; }
export function secretBackend(): SecretBackend { return codec?.backend ?? 'none'; }

export const CONFIG_DIR = process.env.HOSTLER_CONFIG_DIR || path.join(os.homedir(), '.config', 'hostler');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const KNOWN_HOSTS = path.join(CONFIG_DIR, 'known_hosts.json');

export interface ConfigData {
  machines: MachineConfig[];
  workspaces: WorkspaceConfig[];
  settings: { port?: number; theme?: string };
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // migrate from the pre-rename config dir (AgentManager -> Hostler)
    const legacy = path.join(os.homedir(), '.config', 'agentmanager');
    if (!process.env.HOSTLER_CONFIG_DIR && fs.existsSync(legacy)) {
      for (const f of ['config.json', 'token', 'known_hosts.json']) {
        try { fs.copyFileSync(path.join(legacy, f), path.join(CONFIG_DIR, f)); } catch { /* absent */ }
      }
    }
  }
}

export function loadConfig(): ConfigData {
  ensureDir();
  let cfg: ConfigData;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg = { machines: raw.machines || [], workspaces: raw.workspaces || [], settings: raw.settings || {} };
  } catch {
    return { machines: [], workspaces: [], settings: {} };
  }
  let migrate = false;
  for (const m of cfg.machines as MachineConfig[]) {
    if (m.passwordEnc && codec) {
      try { m.password = codec.decrypt(m.passwordEnc); } catch { console.warn(`[config] cannot decrypt saved password for ${m.name} (keychain changed?)`); }
    }
    if (m.password && !m.passwordEnc && m.savePassword) migrate = true; // legacy plain-text password from an older build
  }
  if (migrate) saveConfig(cfg); // re-persist: encrypted if a codec is available, otherwise dropped from disk
  return cfg;
}

export function saveConfig(cfg: ConfigData) {
  ensureDir();
  const persisted = {
    ...cfg,
    machines: cfg.machines.map((m) => {
      const { password, ...rest } = m;
      // plain passwords are never written; encrypt when possible, otherwise keep an existing ciphertext untouched
      const passwordEnc = m.savePassword && password && codec ? codec.encrypt(password) : m.savePassword ? m.passwordEnc : undefined;
      return { ...rest, passwordEnc };
    }),
  };
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

export function loadOrCreateToken(): string {
  ensureDir();
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* create */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

export function loadKnownHosts(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(KNOWN_HOSTS, 'utf8')); } catch { return {}; }
}

export function saveKnownHosts(kh: Record<string, string>) {
  ensureDir();
  fs.writeFileSync(KNOWN_HOSTS, JSON.stringify(kh, null, 2), { mode: 0o600 });
}

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(6).toString('hex');
}
