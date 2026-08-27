import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Resolved = 'light' | 'dark';

const KEY = 'hostler_theme';
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
let pref: ThemePref = (() => {
  try {
    const q = new URLSearchParams(location.search).get('theme') as ThemePref | null;
    if (q === 'light' || q === 'dark' || q === 'system') { localStorage.setItem(KEY, q); return q; }
    return (localStorage.getItem(KEY) as ThemePref) || 'system';
  } catch { return 'system'; }
})();
const listeners = new Set<() => void>();

export function resolvedTheme(): Resolved {
  if (pref === 'system') return mq && mq.matches ? 'light' : 'dark';
  return pref;
}
export function themePref() { return pref; }

let version = 0;
function notify() {
  version++;
  for (const l of listeners) l();
}

function apply() {
  const r = resolvedTheme();
  document.documentElement.dataset.theme = r;
  document.documentElement.style.colorScheme = r;
  notify();
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply();
}
export function cycleThemePref() {
  setThemePref(pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system');
}
export function onThemeChange(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function useTheme() {
  return useSyncExternalStore((l) => onThemeChange(l), () => `${pref}:${resolvedTheme()}:${version}`);
}

/**
 * Terminal theme per harness: a Codex TUI drawn for a dark terminal stays readable even when
 * the rest of Hostler is light, so each agent type keeps its own light/dark choice
 * ('app' follows the application theme).
 */
export type TermThemePref = 'app' | 'light' | 'dark';
const TERM_KEY = 'hostler_term_theme';
let termPrefs: Record<string, TermThemePref> = (() => {
  try { return JSON.parse(localStorage.getItem(TERM_KEY) || '{}') || {}; } catch { return {}; }
})();

export function termThemePref(kind: string): TermThemePref {
  return termPrefs[kind] || 'app';
}
export function setTermThemePref(kind: string, p: TermThemePref) {
  termPrefs = { ...termPrefs, [kind]: p };
  try { localStorage.setItem(TERM_KEY, JSON.stringify(termPrefs)); } catch { /* ignore */ }
  notify();
}
export function cycleTermThemePref(kind: string) {
  const cur = termThemePref(kind);
  setTermThemePref(kind, cur === 'app' ? 'light' : cur === 'light' ? 'dark' : 'app');
}
export function resolvedTermTheme(kind: string): Resolved {
  const p = termThemePref(kind);
  return p === 'app' ? resolvedTheme() : p;
}

mq?.addEventListener?.('change', () => { if (pref === 'system') apply(); });
apply();

/**
 * xterm.js theme. The ANSI palette is the standard terminal one (Tango on dark, the usual
 * light-terminal set on light) so every CLI renders in *its own* colors — Hostler only owns
 * the background, foreground and cursor so the terminal fits the app's light/dark chrome.
 */
export function terminalTheme(r: Resolved = resolvedTheme()) {
  return r === 'light'
    ? { background: '#ffffff', foreground: '#1f2430', cursor: '#1f2430', cursorAccent: '#ffffff', selectionBackground: 'rgba(91,108,255,.25)',
        black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
        brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' }
    : { background: '#0a0c11', foreground: '#d3d7cf', cursor: '#e6e8ee', cursorAccent: '#0a0c11', selectionBackground: 'rgba(109,141,255,.35)',
        black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
        brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec' };
}

/** The terminal font stack (single source of truth: the --term-font CSS variable). */
export function terminalFont(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--term-font').trim();
    if (v) return v;
  } catch { /* ignore */ }
  return 'monospace';
}
