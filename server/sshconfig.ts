import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SshHostEntry } from '../shared/types';

/** Minimal ~/.ssh/config parser (Host / HostName / User / Port / IdentityFile / ProxyJump, Include). */
export function parseSshConfig(file = path.join(os.homedir(), '.ssh', 'config'), depth = 0): SshHostEntry[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const entries: SshHostEntry[] = [];
  let current: SshHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s*[=\s]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'include' && depth < 3) {
      for (const pat of value.split(/\s+/)) {
        const p = pat.startsWith('/') ? pat : path.join(os.homedir(), '.ssh', pat);
        if (fs.existsSync(p)) entries.push(...parseSshConfig(p, depth + 1));
      }
      continue;
    }
    if (key === 'host') {
      current = value.split(/\s+/).filter((h) => !h.includes('*') && !h.includes('?') && !h.startsWith('!')).map((host) => ({ host }));
      entries.push(...current);
      continue;
    }
    if (key === 'match') { current = []; continue; }
    for (const e of current) {
      if (key === 'hostname') e.hostName = value;
      else if (key === 'user') e.user = value;
      else if (key === 'port') e.port = parseInt(value, 10);
      else if (key === 'identityfile' && !e.identityFile) e.identityFile = value.replace(/^~/, os.homedir());
      else if (key === 'proxyjump') e.proxyJump = value;
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
