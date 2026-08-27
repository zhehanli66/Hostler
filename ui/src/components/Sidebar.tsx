import React, { useContext, useState } from 'react';
import type { AppState, MachineState, SessionInfo } from '@shared/types';
import { AppCtx, type Selection } from '../App';
import { api } from '../api';
import { classNames, pct, runningSubagents, sessionTone, shortPath, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';
import { cycleThemePref, themePref, useTheme } from '../theme';

export function Sidebar({ state, sel }: { state: AppState; sel: Selection }) {
  const { openModal, select } = useContext(AppCtx);
  const live = state.machines.reduce((a, m) => a + m.sessions.filter((s) => s.status === 'running' || s.status === 'adopted').length, 0);
  useTheme();
  const tp = themePref();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo"><Icon name="server" size={15} strokeWidth={2.2} /></div>
        <div className="title">Hostler</div>
        <button className="btn ghost sm icon" title={`theme: ${tp} (click to change)`} onClick={cycleThemePref}><Icon name={tp === 'system' ? 'monitor' : tp === 'light' ? 'sun' : 'moon'} size={14} /></button>
        <div className={classNames('conn', api.connected && 'on')} title={api.connected ? 'connected to control plane' : 'control plane offline'} />
      </div>
      <div className="nav">
        <div className={classNames('tree-row', sel?.view === 'usage' && 'selected')} onClick={() => select({ view: 'usage' })}>
          <span className="caret"><Icon name="zap" size={13} /></span>
          <span className="name">Usage</span>
        </div>
      </div>
      <div className="side-section">
        Machines <span className="spacer" />
        <button className="btn ghost sm icon" title="Add machine" onClick={() => openModal({ type: 'addMachine' })}><Icon name="plus" size={14} /></button>
      </div>
      <div className="tree">
        {state.machines.map((m) => <MachineNode key={m.config.id} m={m} sel={sel} workspaces={state.workspaces.filter((w) => w.machineId === m.config.id).map((w) => w.path)} />)}
        {state.machines.length === 0 && <div className="tree-empty">No machines yet</div>}
      </div>
      <div className="side-foot">
        <Icon name="activity" size={13} /> {live} agent{live === 1 ? '' : 's'} live · {state.machines.filter((m) => m.status === 'connected').length}/{state.machines.length} machines
        <span style={{ flex: 1 }} />
        {sel?.machineId && <button className="btn sm primary" onClick={() => openModal({ type: 'newAgent', machineId: sel.machineId!, cwd: sel.workspace })}><Icon name="plus" size={13} /> Agent</button>}
      </div>
    </aside>
  );
}

function MachineNode({ m, sel, workspaces }: { m: MachineState; sel: Selection; workspaces: string[] }) {
  const { select } = useContext(AppCtx);
  const [open, setOpen] = useState(true);
  const r = m.resources;
  const gpu = r?.gpus?.[0];
  const isSel = sel?.machineId === m.config.id && !sel.sessionId && !sel.workspace && !sel.view;
  const groups = new Map<string, SessionInfo[]>();
  for (const p of workspaces) groups.set(p, []);
  for (const s of m.sessions) { const k = s.workspace || s.cwd; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s); }
  const home = m.hello?.home;
  const live = m.sessions.filter((s) => s.status === 'running' || s.status === 'adopted').length;
  const sub = m.hello ? m.hello.hostname : m.config.transport === 'local' ? 'local' : m.config.host || '';
  return (
    <div className="tree-machine">
      <div className={classNames('tree-row', isSel && 'selected')} onClick={() => select({ machineId: m.config.id })}>
        <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /></span>
        <span className={classNames('dot', m.status)} title={m.status + (m.error ? ': ' + m.error : '')} />
        <span className="name">{m.config.name}<small>{m.status === 'connected' ? sub : m.status}{live ? ` · ${live} live` : ''}</small></span>
        {r && (
          <span className="minibars" title={`CPU ${r.cpu_pct}% · RAM ${Math.round(pct(r.mem_used, r.mem_total))}%${gpu ? ` · GPU ${gpu.util ?? '?'}% · VRAM ${Math.round(pct(gpu.mem_used, gpu.mem_total))}%` : ''}`}>
            <span className="minibar cpu"><i style={{ height: `${r.cpu_pct}%` }} /></span>
            <span className="minibar mem"><i style={{ height: `${pct(r.mem_used, r.mem_total)}%` }} /></span>
            {gpu && <span className="minibar gpu"><i style={{ height: `${gpu.util ?? 0}%` }} /></span>}
            {gpu && <span className="minibar vram"><i style={{ height: `${pct(gpu.mem_used, gpu.mem_total)}%` }} /></span>}
          </span>
        )}
      </div>
      {open && (
        <div className="tree-children">
          {m.status !== 'connected' && m.status !== 'disconnected' && <div className="tree-empty">{m.status}{m.error ? ` — ${m.error}` : ''}</div>}
          {m.hello?.cluster?.kind && (
            <div className={classNames('tree-row tree-ws', sel?.machineId === m.config.id && sel.view === 'cluster' && 'selected')}
              title={`${m.hello.cluster.kind} scheduler on this machine`} onClick={() => select({ machineId: m.config.id, view: 'cluster' })}>
              <span className="caret"><Icon name="layers" size={12} /></span>
              <span className="name">{'\u200E' + 'cluster queue' + '\u200E'}</span>
              <span className="meta">{m.hello.cluster.kind}</span>
            </div>
          )}
          {[...groups.entries()].map(([path, sessions]) => <WorkspaceNode key={path} m={m} path={path} sessions={sessions} sel={sel} home={home} />)}
          {m.status === 'connected' && groups.size === 0 && <div className="tree-empty">no agents yet</div>}
          {m.discovered.filter((d) => !d.background).length > 0 && (
            <div className="tree-row" onClick={() => select({ machineId: m.config.id })} style={{ height: 26 }}>
              <span className="caret"><Icon name="eye" size={12} /></span>
              <span className="name muted small">{m.discovered.filter((d) => !d.background).length} unmanaged — adopt?</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceNode({ m, path, sessions, sel, home }: { m: MachineState; path: string; sessions: SessionInfo[]; sel: Selection; home?: string | null }) {
  const { select } = useContext(AppCtx);
  const [open, setOpen] = useState(true);
  const isSel = sel?.machineId === m.config.id && sel.workspace === path && !sel.sessionId;
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'adopted');
  const busy = live.some((s) => sessionTone(s) === 'busy');
  return (
    <div>
      <div className={classNames('tree-row tree-ws', isSel && 'selected')} title={path} onClick={() => select({ machineId: m.config.id, workspace: path })}>
        <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /></span>
        <Icon name="folder" size={13} />
        <span className="name">{'\u200E' + shortPath(path, home) + '\u200E'}</span>
        {!open && busy && <span className="dot busy" style={{ width: 6, height: 6 }} />}
        <span className="meta">{live.length ? `${live.length}/${sessions.length}` : sessions.length || ''}</span>
      </div>
      {open && (
        <div className="tree-children">
          {sessions.map((s) => <SessionNode key={s.id} m={m} s={s} sel={sel} />)}
          {sessions.length === 0 && <div className="tree-empty">empty</div>}
        </div>
      )}
    </div>
  );
}

function SessionNode({ m, s, sel }: { m: MachineState; s: SessionInfo; sel: Selection }) {
  const { select } = useContext(AppCtx);
  const isSel = sel?.machineId === m.config.id && sel.sessionId === s.id;
  const subs = runningSubagents(s);
  const tone = sessionTone(s);
  const finished = s.status === 'exited' || s.status === 'lost';
  return (
    <div>
      <div className={classNames('tree-row tree-agent', isSel && 'selected')} style={finished ? { opacity: 0.6 } : undefined} onClick={() => select({ machineId: m.config.id, workspace: s.workspace || s.cwd, sessionId: s.id })} title={`${TYPE_LABEL[s.type] || s.type} · ${s.status}`}>
        <TypeAvatar type={s.type} size={20} />
        <span className="name">{s.name}</span>
        {finished ? <span className="meta">exit {s.exit_code ?? '?'}</span> : <span className={classNames('dot', tone)} style={{ width: 6, height: 6 }} />}
        {subs.length > 0 && <span className="meta">{subs.length} sub</span>}
      </div>
      {subs.slice(0, 6).map((sa) => (
        <div key={sa.id} className="tree-sub" title={sa.description || ''}>
          <Icon name="layers" size={11} />
          <span className="name">{sa.description || sa.type || sa.id}</span>
          {sa.activity?.current_tool && <span className="meta">{sa.activity.current_tool.name}</span>}
        </div>
      ))}
    </div>
  );
}
