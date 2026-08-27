import React, { useContext } from 'react';
import type { MachineState, WorkspaceConfig } from '@shared/types';
import { AppCtx } from '../App';
import { api } from '../api';
import { GitPanel } from './GitPanel';
import { HistoryCard } from './History';
import { SessionTable } from './SessionTable';
import { classNames, fmtBytes, runningSubagents, sessionTone, shortPath } from '../util';
import { Icon } from './icons';

export function WorkspaceView({ machine: m, path, workspace }: { machine: MachineState; path: string; workspace?: WorkspaceConfig }) {
  const { openModal, select } = useContext(AppCtx);
  const home = m.hello?.home;
  const connected = m.status === 'connected';
  const sessions = m.sessions.filter((s) => (s.workspace || s.cwd) === path);
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'adopted');
  const busy = live.filter((s) => sessionTone(s) === 'busy');
  const subs = live.reduce((a, s) => a + runningSubagents(s).length, 0);
  const procs = live.reduce((a, s) => a + s.processes.length, 0);
  const cpu = live.reduce((a, s) => a + s.processes.reduce((b, p) => b + (p.cpu || 0), 0), 0);
  const rss = live.reduce((a, s) => a + s.processes.reduce((b, p) => b + (p.rss || 0), 0), 0);
  const vram = live.reduce((a, s) => a + s.processes.reduce((b, p) => b + (p.gpu_mem || 0), 0), 0);
  const forget = () => {
    if (!workspace) return;
    if (sessions.length && !confirm(`Remove workspace "${workspace.name}" from the list? Its ${sessions.length} agent(s) keep running and stay listed under their directory.`)) return;
    api.call('workspace.remove', { workspaceId: workspace.id }).then(() => select({ machineId: m.config.id }));
  };
  return (
    <>
      <div className="topbar">
        <div className="crumb"><a onClick={() => select({ machineId: m.config.id })}>{m.config.name}</a> /</div>
        <h1>
          <span className={classNames('dot', busy.length ? 'busy' : live.length ? 'running' : 'muted')} />
          {workspace?.name || path.split('/').filter(Boolean).pop() || path}
          <span className="sub" title={path}>{shortPath(path, home)}</span>
        </h1>
        <div className="spacer" />
        {workspace ? <button className="btn ghost" onClick={forget} title="remove from workspace list (agents are not stopped)"><Icon name="x" size={14} /> Forget</button>
          : <button className="btn" disabled={!connected} onClick={() => api.call('workspace.add', { machineId: m.config.id, path })}><Icon name="pin" size={14} /> Pin as workspace</button>}
        <button className="btn primary" disabled={!connected} onClick={() => openModal({ type: 'newAgent', machineId: m.config.id, cwd: path })}><Icon name="plus" size={14} /> New Agent here</button>
      </div>
      <div className="content">
        <div className="card" style={{ marginBottom: 14 }}>
          <h3><Icon name="bot" size={13} /> Agents in this workspace <span className="sub">{live.length} live · {sessions.length - live.length} finished</span><span className="spacer" />
            {sessions.some((s) => s.status === 'exited' || s.status === 'lost') && <button className="btn sm ghost" onClick={() => sessions.filter((s) => s.status === 'exited' || s.status === 'lost').forEach((s) => api.rpc(m.config.id, 'session.remove', { session: s.id }).catch(() => undefined))}>clear finished</button>}
          </h3>
          {live.length > 0 && (
            <div className="stats">
              <span className="stat"><Icon name="activity" size={12} /><b>{busy.length}</b> busy</span>
              <span className="stat"><Icon name="layers" size={12} /><b>{subs}</b> subagent{subs === 1 ? '' : 's'} running</span>
              <span className="stat"><Icon name="list" size={12} /><b>{procs}</b> process{procs === 1 ? '' : 'es'}</span>
              <span className="stat"><Icon name="cpu" size={12} /><b>{cpu.toFixed(0)}%</b> CPU</span>
              <span className="stat"><Icon name="memory" size={12} /><b>{fmtBytes(rss, 0)}</b> RSS</span>
              {vram ? <span className="stat"><Icon name="gpu" size={12} /><b>{fmtBytes(vram, 0)}</b> VRAM</span> : null}
            </div>
          )}
          <SessionTable machine={m} sessions={sessions} home={home} showDirectory={false} onOpen={(sid) => select({ machineId: m.config.id, workspace: path, sessionId: sid })}
            empty={<div className="empty"><Icon name="bot" size={22} /><div>No agents in {shortPath(path, home)} yet.</div>{connected && <button className="btn sm primary" onClick={() => openModal({ type: 'newAgent', machineId: m.config.id, cwd: path })}><Icon name="plus" size={13} /> New Agent here</button>}</div>} />
        </div>
        <HistoryCard machine={m} cwd={path} />
        {connected ? <GitPanel machineId={m.config.id} cwd={path} /> : <div className="empty">not connected</div>}
      </div>
    </>
  );
}
