import React from 'react';
import type { ProcessInfo, SessionInfo } from '@shared/types';
import { api } from '../api';
import { ago, fmtBytes } from '../util';

export function ProcessTree({ machineId, session }: { machineId: string; session: SessionInfo }) {
  const procs = session.processes;
  if (!procs.length) return <div className="empty">No live processes{session.status !== 'running' && session.status !== 'adopted' ? ' — session ended' : ''}</div>;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, ProcessInfo[]>();
  const roots: ProcessInfo[] = [];
  for (const p of procs) {
    if (p.root || !byPid.has(p.ppid)) roots.push(p);
    else { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid)!.push(p); }
  }
  const rows: { p: ProcessInfo; depth: number }[] = [];
  const walk = (p: ProcessInfo, depth: number) => { rows.push({ p, depth }); for (const c of children.get(p.pid) || []) walk(c, depth + 1); };
  roots.sort((a, b) => (a.root ? -1 : b.root ? 1 : a.started - b.started));
  for (const r of roots) walk(r, 0);
  const signal = (pid: number, sig: string) => api.act(`signal ${sig}`, () => api.rpc(machineId, 'process.signal', { pid, signal: sig }));
  return (
    <div className="proc-tree">
      <div className="row head"><div>Process</div><div className="num">CPU</div><div className="num">RSS</div><div className="num">VRAM</div><div>Started</div></div>
      {rows.map(({ p, depth }) => (
        <div className="row" key={p.pid}>
          <div className="cmd" title={p.cmd} style={{ paddingLeft: depth * 16 }}>
            <span className="pid">{p.pid}</span>{depth > 0 ? '└ ' : ''}<b>{p.name}</b> <span className="muted">{p.cmd}</span>
            {p.detached && <span className="tag" title="re-parented (nohup/setsid/daemon) — still attributed to this agent">detached</span>}
            {p.state === 'Z' && <span className="tag">zombie</span>}
            {p.state === 'T' && <span className="tag">stopped</span>}
          </div>
          <div className="num">{p.cpu.toFixed(0)}%</div>
          <div className="num">{fmtBytes(p.rss, 0)}</div>
          <div className="num">{p.gpu_mem ? fmtBytes(p.gpu_mem, 0) : ''}</div>
          <div className="row-flex"><span className="muted">{ago(p.started)}</span>{!p.root && <button className="btn sm ghost" title="SIGTERM" onClick={() => signal(p.pid, 'TERM')}>✕</button>}</div>
        </div>
      ))}
    </div>
  );
}
