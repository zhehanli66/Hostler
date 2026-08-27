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

function apply() {
  const r = resolvedTheme();
  document.documentElement.dataset.theme = r;
  document.documentElement.style.colorScheme = r;
  for (const l of listeners) l();
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
  return useSyncExternalStore((l) => onThemeChange(l), () => `${pref}:${resolvedTheme()}`);
}

mq?.addEventListener?.('change', () => { if (pref === 'system') apply(); });
apply();

/** xterm.js theme matching the active palette */
export function terminalTheme(r: Resolved = resolvedTheme()) {
  return r === 'light'
    ? { background: '#f7f8fa', foreground: '#1f2430', cursor: '#1f2430', cursorAccent: '#f7f8fa', selectionBackground: 'rgba(91,108,255,.25)',
        black: '#1f2430', red: '#d13b47', green: '#1a9e5c', yellow: '#b7791f', blue: '#3b5bdb', magenta: '#8b5cf6', cyan: '#0e8a8a', white: '#8a919e',
        brightBlack: '#6b7280', brightRed: '#e0505c', brightGreen: '#22b36a', brightYellow: '#d69e2e', brightBlue: '#4c6ef5', brightMagenta: '#a78bfa', brightCyan: '#14a3a3', brightWhite: '#1f2430' }
    : { background: '#0a0c11', foreground: '#d6dae3', cursor: '#e6e8ee', cursorAccent: '#0a0c11', selectionBackground: 'rgba(109,141,255,.35)',
        black: '#1b1f2a', red: '#f0616f', green: '#3ecf8e', yellow: '#f6b64b', blue: '#6d8dff', magenta: '#a78bfa', cyan: '#4cc9f0', white: '#c9cfdb',
        brightBlack: '#5b6270', brightRed: '#ff7b86', brightGreen: '#5fe0a5', brightYellow: '#ffc76b', brightBlue: '#8aa4ff', brightMagenta: '#c4b1ff', brightCyan: '#7ad9f5', brightWhite: '#ffffff' };
}
