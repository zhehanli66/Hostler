import type { Activity, ConversationActivity, SessionInfo, Subagent } from '@shared/types';

export function fmtBytes(n?: number | null, digits = 1): string {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}

export function fmtDuration(sec?: number | null): string {
  if (sec == null || sec < 0) return '–';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(epochSec?: number | null): string {
  if (!epochSec) return '–';
  return fmtDuration(Date.now() / 1000 - epochSec) + ' ago';
}

export function agoIso(iso?: string | null): string {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (isNaN(t)) return '–';
  return fmtDuration((Date.now() - t) / 1000) + ' ago';
}

export function pct(a?: number | null, b?: number | null): number {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(100, (100 * a) / b));
}

export const TYPE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', shell: 'Shell', custom: 'Custom' };

export function activitySummary(a?: ConversationActivity | Activity | null): { label: string; detail: string; tone: string } {
  if (!a) return { label: 'no activity data', detail: '', tone: 'muted' };
  switch (a.status) {
    case 'tool': return { label: `running ${a.current_tool?.name || 'tool'}`, detail: a.current_tool?.summary || '', tone: 'busy' };
    case 'thinking': return { label: 'thinking', detail: a.last_prompt ? `on: ${a.last_prompt}` : '', tone: 'busy' };
    case 'subagents': return { label: 'waiting on subagents', detail: '', tone: 'busy' };
    case 'idle': return { label: 'waiting for input', detail: a.last_text || '', tone: 'idle' };
    case 'error': return { label: 'introspection error', detail: (a as Activity).error || '', tone: 'error' };
    default: return { label: 'no transcript yet', detail: '', tone: 'muted' };
  }
}

export function sessionTone(s: SessionInfo): string {
  if (s.status === 'exited' || s.status === 'lost') return s.exit_code === 0 || s.exit_code == null ? 'muted' : 'error';
  const a = s.activity;
  if (a && (a.status === 'tool' || a.status === 'thinking' || a.status === 'subagents')) return 'busy';
  if (a && a.status === 'idle') return 'idle';
  return 'running';
}

export function runningSubagents(s: SessionInfo): Subagent[] {
  return (s.activity?.subagents || []).filter((x) => x.status === 'running');
}

export function classNames(...xs: (string | false | null | undefined)[]) { return xs.filter(Boolean).join(' '); }

/** keep the tail of a long path (the interesting end), with a leading ellipsis */
export function tailPath(p: string, max = 36) {
  return p.length <= max ? p : '…' + p.slice(p.length - max);
}

export function shortPath(p?: string | null, home?: string | null) {
  if (!p) return '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

/**
 * Official install command per agent CLI — shown in the dialog and editable before it runs.
 * All three install for the machine's own user (no sudo) into ~/.local/bin, which Hostler probes
 * even when it is not on PATH; the codex installer also lays down its `codex-code-mode-host`
 * companion, which a bare binary drop would miss.
 */
export function installCommand(tool: string): string {
  if (tool === 'claude') return 'curl -fsSL https://claude.ai/install.sh | bash';
  if (tool === 'codex') return 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';
  if (tool === 'opencode') return 'curl -fsSL https://opencode.ai/install | bash';
  return '';
}

/** Copy to the clipboard, with a fallback for contexts where the async API is unavailable. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* not permitted / insecure context — fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
