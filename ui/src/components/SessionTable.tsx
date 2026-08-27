import React, { useContext } from 'react';
import type { MachineState, SessionInfo } from '@shared/types';
import { AppCtx } from '../App';
import { api } from '../api';
import { activitySummary, ago, classNames, fmtBytes, runningSubagents, sessionTone, shortPath, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';

/** Table of agent sessions; used by the machine page (per workspace group) and the workspace page. */
export function SessionTable({ machine: m, sessions, home, showDirectory = true, onOpen, empty }: { machine: MachineState; sessions: SessionInfo[]; home?: string | null; showDirectory?: boolean; onOpen: (sid: string) => void; empty?: React.ReactNode }) {
  if (sessions.length === 0) return <>{empty ?? null}</>;
  const order = (s: SessionInfo) => (s.status === 'running' || s.status === 'adopted' ? (sessionTone(s) === 'busy' ? 0 : 1) : 2);
  const sorted = [...sessions].sort((a, b) => order(a) - order(b) || (b.started || b.created) - (a.started || a.created));
  return (
    <div className="tbl-wrap"><table className="tbl">
      <thead><tr><th></th><th>Name</th><th>Type</th>{showDirectory && <th>Directory</th>}<th>Activity</th><th className="num">CPU · RSS · VRAM</th><th>Age</th><th></th></tr></thead>
      <tbody>
        {sorted.map((s) => <SessionRow key={s.id} m={m} s={s} home={home} showDirectory={showDirectory} onOpen={() => onOpen(s.id)} />)}
      </tbody>
    </table></div>
  );
}

function SessionRow({ m, s, home, onOpen, showDirectory }: { m: MachineState; s: SessionInfo; home?: string | null; onOpen: () => void; showDirectory: boolean }) {
  const { openModal } = useContext(AppCtx);
  const cpu = s.processes.reduce((a, p) => a + (p.cpu || 0), 0);
  const rss = s.processes.reduce((a, p) => a + (p.rss || 0), 0);
  const vram = s.processes.reduce((a, p) => a + (p.gpu_mem || 0), 0);
  const act = activitySummary(s.activity);
  const subs = runningSubagents(s);
  const live = s.status === 'running' || s.status === 'adopted';
  return (
    <tr className="clickable" onClick={onOpen}>
      <td style={{ width: 20 }}><span className={classNames('dot', sessionTone(s))} /></td>
      <td><span className="name-cell"><TypeAvatar type={s.type} size={26} /><span style={{ minWidth: 0 }}><span className="t">{s.name}</span><span className="s">{s.activity?.title && s.activity.title !== s.name ? s.activity.title : TYPE_LABEL[s.type] || s.type}</span></span></span></td>
      <td className="nowrap"><span className={classNames('badge', s.type)}>{TYPE_LABEL[s.type] || s.type}</span>{s.adopted && <span className="badge muted" style={{ marginLeft: 4 }}>adopted</span>}</td>
      {showDirectory && <td className="mono trunc" style={{ maxWidth: 200 }} title={s.cwd}>{shortPath(s.cwd, home)}</td>}
      <td className="trunc" style={{ maxWidth: 260 }} title={act.detail}>
        {live ? <><span className={classNames('badge', act.tone)}>{act.label}</span>{subs.length ? <span className="badge busy" style={{ marginLeft: 6 }}><Icon name="layers" size={11} /> {subs.length}</span> : null}{act.detail && <div className="muted small mono trunc" style={{ marginTop: 3 }}>{act.detail}</div>}</> : <span className="badge muted">{s.status}{s.exit_code != null ? ` · code ${s.exit_code}` : ''}</span>}
      </td>
      <td className="num nowrap">{live ? `${cpu.toFixed(0)}% · ${fmtBytes(rss, 0)}${vram ? ` · ${fmtBytes(vram, 0)}` : ''}` : ''}</td>
      <td className="nowrap muted">{ago(s.started || s.created)}</td>
      <td className="actions" onClick={(e) => e.stopPropagation()}>
        <span className="row-actions">
          <button className="btn sm ghost icon" title="Open terminal" onClick={onOpen}><Icon name="terminal" size={13} /></button>
          {live && !s.adopted && <button className="btn sm ghost icon" title="Stop" onClick={() => api.act('stop', () => api.rpc(m.config.id, 'session.stop', { session: s.id }))}><Icon name="stop" size={13} /></button>}
          {live && s.adopted && <button className="btn sm ghost icon" title="Stop (SIGTERM)" onClick={() => openModal({ type: 'confirm', title: 'Stop adopted process', text: `Send SIGTERM to pid ${s.pid} and its children?`, onOk: () => api.act('stop', () => api.rpc(m.config.id, 'session.signal', { session: s.id, signal: 'TERM' })) })}><Icon name="stop" size={13} /></button>}
          {!live && !s.adopted && <button className="btn sm ghost icon" title="Restart" onClick={() => api.act('restart', () => api.rpc(m.config.id, 'session.restart', { session: s.id }))}><Icon name="restart" size={13} /></button>}
          {!live && <button className="btn sm ghost icon" title="Remove" onClick={() => api.act('remove', () => api.rpc(m.config.id, 'session.remove', { session: s.id }))}><Icon name="trash" size={13} /></button>}
        </span>
      </td>
    </tr>
  );
}

