import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SshHostEntry } from '../shared/types';

/** Expand an Include pattern: absolute or relative to ~/.ssh, with * and ? in the last path segment. */
function expandInclude(pat: string): string[] {
  const p = pat.startsWith('/') ? pat : path.join(os.homedir(), '.ssh', pat.replace(/^~\//, os.homedir() + '/'));
  if (!/[*?]/.test(p)) return fs.existsSync(p) ? [p] : [];
  const dir = path.dirname(p);
  const rx = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  try { return fs.readdirSync(dir).filter((n) => rx.test(n)).sort().map((n) => path.join(dir, n)); } catch { return []; }
}

/** Minimal ~/.ssh/config parser (Host / HostName / User / Port / IdentityFile / ProxyJump, Include). */
export function parseSshConfig(file = path.join(os.homedir(), '.ssh', 'config'), depth = 0): SshHostEntry[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const entries: SshHostEntry[] = [];
  const defaults: SshHostEntry = { host: '*' };   // values from a plain `Host *` block apply to every host that lacks them
  let current: SshHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*[=\s]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'include' && depth < 3) {
      for (const pat of value.split(/\s+/)) for (const p of expandInclude(pat)) entries.push(...parseSshConfig(p, depth + 1));
      continue;
    }
    if (key === 'host') {
      const names = value.split(/\s+/);
      current = names.filter((h) => !h.includes('*') && !h.includes('?') && !h.startsWith('!')).map((host) => ({ host }));
      if (names.length === 1 && names[0] === '*') current = [defaults];
      else entries.push(...current);
      continue;
    }
    if (key === 'match') { current = []; continue; }
    for (const e of current) {
      if (key === 'hostname') e.hostName = value;
      else if (key === 'user' && !e.user) e.user = value;
      else if (key === 'port' && !e.port) e.port = parseInt(value, 10);
      else if (key === 'identityfile' && !e.identityFile) e.identityFile = value.replace(/^~/, os.homedir());
      else if (key === 'proxyjump' && !e.proxyJump) e.proxyJump = value;
    }
  }
  if (depth === 0) {
    for (const e of entries) {
      if (!e.user && defaults.user) e.user = defaults.user;
      if (!e.port && defaults.port) e.port = defaults.port;
      if (!e.identityFile && defaults.identityFile) e.identityFile = defaults.identityFile;
    }
  }
  return entries;
}

export function findSshHost(alias: string): SshHostEntry | undefined {
  return parseSshConfig().find((e) => e.host === alias);
}

export function defaultIdentityFiles(): string[] {
  const dir = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk', 'id_dsa']
    .map((n) => path.join(dir, n))
    .filter((p) => fs.existsSync(p));
}
