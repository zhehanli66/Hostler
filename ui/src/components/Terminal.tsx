import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, b64ToBytes, textToB64 } from '../api';
import { cycleTermThemePref, resolvedTermTheme, terminalFont, terminalTheme, termThemePref, useTheme } from '../theme';
import { TYPE_LABEL, writeClipboard } from '../util';
import { Icon } from './icons';

/** terminal text size, remembered across sessions (the font itself is the machine's own — see --term-font) */
const FONT_KEY = 'hostler_term_font_size';
const readFontSize = () => {
  try { return Math.min(24, Math.max(9, parseInt(localStorage.getItem(FONT_KEY) || '', 10) || 14)); } catch { return 14; }
};

export function TerminalView({ machineId, sessionId, kind, readOnly }: { machineId: string; sessionId: string; kind: string; readOnly?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [line, setLine] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const themeKey = useTheme();
  const termTheme = terminalTheme(resolvedTermTheme(kind));
  const themePref = termThemePref(kind);

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      fontFamily: terminalFont(), fontSize: readFontSize(), lineHeight: 1.2,
      theme: terminalTheme(resolvedTermTheme(kind)),
      scrollback: 20000, allowProposedApi: true, cursorBlink: true, convertEol: false,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    termRef.current = term;
    let disposed = false;
    const doFit = () => { try { fit.fit(); } catch { /* ignore */ } };
    doFit();

    const off = api.on('output', (msg) => {
      if (msg.machineId === machineId && msg.session === sessionId) term.write(b64ToBytes(msg.data));
    });
    api.rpc(machineId, 'session.attach', { session: sessionId, cols: term.cols, rows: term.rows })
      .then((r) => { if (!disposed && r?.scrollback) { term.write(b64ToBytes(r.scrollback)); term.scrollToBottom(); } })
      .catch((e) => setErr(e.message));

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const copyKey = (e.ctrlKey && e.shiftKey && e.code === 'KeyC') || (e.metaKey && !e.ctrlKey && e.code === 'KeyC');
      if (copyKey || (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && term.hasSelection())) {
        const text = term.getSelection();
        if (text) { writeClipboard(text).then((ok) => ok && api.toast('info', 'copied to clipboard')); term.clearSelection(); return false; }
        return !copyKey;      // nothing selected: let ^C reach the agent
      }
      if ((e.ctrlKey && e.shiftKey && e.code === 'KeyV') || (e.metaKey && !e.ctrlKey && e.code === 'KeyV')) {
        navigator.clipboard.readText()
          .then((t) => t && api.rpc(machineId, 'session.input', { session: sessionId, data: textToB64(t) }))
          .catch(() => api.toast('error', 'clipboard read was not permitted — use Ctrl+V'));
        return false;
      }
      return true;
    });
    el.addEventListener('contextmenu', (e) => {
      const text = term.getSelection();
      if (!text) return;                       // no selection: leave the event alone
      e.preventDefault();
      writeClipboard(text).then((ok) => ok && api.toast('info', 'copied to clipboard'));
      term.clearSelection();
    });

    const onData = term.onData((d) => { if (!readOnly) api.rpc(machineId, 'session.input', { session: sessionId, data: textToB64(d) }).catch(() => undefined); });
    const onBinary = term.onBinary((d) => { if (!readOnly) api.rpc(machineId, 'session.input', { session: sessionId, data: btoa(d) }).catch(() => undefined); });
    let resizeTimer: any;
    const onResize = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => api.rpc(machineId, 'session.resize', { session: sessionId, cols, rows }).catch(() => undefined), 120);
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);
    term.focus();
    return () => {
      disposed = true;
      off(); onData.dispose(); onBinary.dispose(); onResize.dispose(); ro.disconnect();
      api.rpc(machineId, 'session.detach', { session: sessionId }).catch(() => undefined);
      term.dispose();
      termRef.current = null;
    };
  }, [machineId, sessionId, readOnly]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(resolvedTermTheme(kind));
  }, [themeKey, kind]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch { /* ignore */ }
    try { fitRef.current?.fit(); } catch { /* ignore */ }
  }, [fontSize]);

  const copy = async () => {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text) {                                // nothing selected: take everything
      term.selectAll();
      text = term.getSelection();
      term.clearSelection();
    }
    if (!text.trim()) { api.toast('info', 'nothing to copy'); return; }
    const ok = await writeClipboard(text);
    api.toast(ok ? 'info' : 'error', ok ? `copied ${text.length} chars` : 'could not reach the clipboard');
  };

  const send = (text: string) => api.rpc(machineId, 'session.input', { session: sessionId, data: textToB64(text) }).catch((e) => api.toast('error', e.message));

  return (
    <>
      <div className="term-bar">
        <span>send input</span>
        <input value={line} placeholder="type a line and press Enter (sent with \n) — or click into the terminal and type directly" onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { send(line + '\n'); setLine(''); } }} />
        <button className="btn sm" title="Ctrl+C" onClick={() => send('\x03')}>^C</button>
        <button className="btn sm" title="Escape" onClick={() => send('\x1b')}>Esc</button>
        <button className="btn sm" title="Enter" onClick={() => send('\r')}>⏎</button>
        <button className="btn sm ghost icon" title={`Terminal theme for ${TYPE_LABEL[kind] || kind} sessions: ${themePref === 'app' ? 'follows the app' : themePref === 'light' ? 'always light' : 'always dark'}`}
          onClick={() => cycleTermThemePref(kind)}><Icon name={themePref === 'light' ? 'sun' : themePref === 'dark' ? 'moon' : 'monitor'} size={13} /></button>
        <button className="btn sm ghost" title="Copy the selection (Ctrl+Shift+C, or right-click). With nothing selected this copies the whole scrollback. Hold Shift while dragging to select when the agent captures the mouse."
          onClick={copy}>copy</button>
        <button className="btn sm ghost" title="Smaller text" onClick={() => setFontSize((f) => Math.max(9, f - 1))}>A−</button>
        <button className="btn sm ghost" title="Larger text" onClick={() => setFontSize((f) => Math.min(24, f + 1))}>A+</button>
        <button className="btn sm ghost" onClick={() => termRef.current?.clear()}>clear</button>
      </div>
      <div className="term-wrap" style={{ background: termTheme.background }}>
        <div ref={ref} style={{ height: '100%' }} />
        {err && <div className="term-notice">{err}</div>}
      </div>
    </>
  );
}
