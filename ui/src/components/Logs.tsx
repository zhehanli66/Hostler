import React, { useEffect, useRef, useState } from 'react';
import { api, b64ToText } from '../api';
import { Icon } from './icons';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>]|\r/g;

export function LogsView({ machineId, sessionId }: { machineId: string; sessionId: string }) {
  const [text, setText] = useState('');
  const [raw, setRaw] = useState(false);
  const [fromFile, setFromFile] = useState(false);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLPreElement>(null);
  const load = () => api.rpc(machineId, 'session.logs', { session: sessionId, tail: 512 * 1024, file: fromFile }).then((r) => setText(b64ToText(r.data))).catch((e) => setText('error: ' + e.message));
  useEffect(() => { load(); }, [machineId, sessionId, fromFile]);
  useEffect(() => {
    if (!follow) return;
    const off = api.on('output', (msg) => { if (msg.machineId === machineId && msg.session === sessionId) setText((t) => (t + b64ToText(msg.data)).slice(-600000)); });
    api.rpc(machineId, 'session.attach', { session: sessionId }).catch(() => undefined);
    return () => { off(); };
  }, [machineId, sessionId, follow]);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text, follow]);
  const shown = raw ? text : text.replace(ANSI, '');
  return (
    <>
      <div className="term-bar">
        <span>{fromFile ? 'on-disk log file (up to 16 MB, rotated)' : 'in-memory scrollback (last 1 MB)'}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <label className="row-flex"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <label className="row-flex"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw ANSI</label>
        <label className="row-flex"><input type="checkbox" checked={fromFile} onChange={(e) => setFromFile(e.target.checked)} /> from file</label>
        <button className="btn sm" onClick={load}><Icon name="refresh" size={13} /> reload</button>
        <button className="btn sm" onClick={() => { const b = new Blob([shown], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${sessionId}.log`; a.click(); }}><Icon name="download" size={13} /> download</button>
      </div>
      <pre className="logs" ref={ref}>{shown || '(empty)'}</pre>
    </>
  );
}
