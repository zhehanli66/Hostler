import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, b64ToBytes, textToB64 } from '../api';
import { onThemeChange, terminalTheme } from '../theme';

export function TerminalView({ machineId, sessionId, readOnly }: { machineId: string; sessionId: string; readOnly?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [line, setLine] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.15,
      theme: terminalTheme(),
      scrollback: 20000, allowProposedApi: true, cursorBlink: true, convertEol: false,
    });
    const fit = new FitAddon();
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

    const onData = term.onData((d) => { if (!readOnly) api.rpc(machineId, 'session.input', { session: sessionId, data: textToB64(d) }).catch(() => undefined); });
    const onBinary = term.onBinary((d) => { if (!readOnly) api.rpc(machineId, 'session.input', { session: sessionId, data: btoa(d) }).catch(() => undefined); });
    let resizeTimer: any;
    const onResize = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => api.rpc(machineId, 'session.resize', { session: sessionId, cols, rows }).catch(() => undefined), 120);
    });
    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);
    const offTheme = onThemeChange(() => { term.options.theme = terminalTheme(); });
    term.focus();
    return () => {
      disposed = true;
      off(); offTheme(); onData.dispose(); onBinary.dispose(); onResize.dispose(); ro.disconnect();
      api.rpc(machineId, 'session.detach', { session: sessionId }).catch(() => undefined);
      term.dispose();
      termRef.current = null;
    };
  }, [machineId, sessionId, readOnly]);

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
        <button className="btn sm ghost" onClick={() => termRef.current?.clear()}>clear</button>
      </div>
      <div className="term-wrap">
        <div ref={ref} style={{ height: '100%' }} />
        {err && <div className="term-notice">{err}</div>}
      </div>
    </>
  );
}
