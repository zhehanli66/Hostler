import React, { useContext, useState } from 'react';
import type { MachineState, SessionInfo } from '@shared/types';
import { AppCtx } from '../App';
import { api } from '../api';
import { ActivityCard, SubagentList } from './Activity';
import { TerminalView } from './Terminal';
import { ProcessTree } from './ProcessTree';
import { GitPanel } from './GitPanel';
import { LogsView } from './Logs';
import { ago, classNames, fmtBytes, runningSubagents, sessionTone, shortPath, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';

type Tab = 'terminal' | 'activity' | 'processes' | 'logs' | 'git';

export function AgentView({ machine: m, session: s }: { machine: MachineState; session: SessionInfo }) {
  const { select, openModal } = useContext(AppCtx);
  const [tab, setTab] = useState<Tab>('terminal');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);
  const live = s.status === 'running' || s.status === 'adopted';
  const mid = m.config.id;
  const home = m.hello?.home;
  const subs = runningSubagents(s);
  const cpu = s.processes.reduce((a, p) => a + (p.cpu || 0), 0);
  const rss = s.processes.reduce((a, p) => a + (p.rss || 0), 0);
  const vram = s.processes.reduce((a, p) => a + (p.gpu_mem || 0), 0);
  const detached = s.processes.filter((p) => p.detached).length;

  const stop = () => api.act('stop', () => api.rpc(mid, s.adopted ? 'session.signal' : 'session.stop', s.adopted ? { session: s.id, signal: 'TERM' } : { session: s.id }));
  const kill = () => openModal({ type: 'confirm', title: 'Kill process tree', text: `SIGKILL ${s.name} (pid ${s.pid}) and all ${s.processes.length} process(es)?`, danger: true, onOk: () => api.act('kill', () => api.rpc(mid, 'session.signal', { session: s.id, signal: 'KILL', tree: true })) });
  const restart = () => api.act('restart', () => api.rpc(mid, 'session.restart', { session: s.id }));
  const remove = () => api.act('remove', async () => { await api.rpc(mid, 'session.remove', { session: s.id, force: true }); select({ machineId: mid, workspace: s.workspace || s.cwd }); });
  const openTmux = () => api.act('open tmux', async () => {
    const r = await api.rpc(mid, 'session.create', { spec: { type: 'custom', name: `tmux: ${s.name}`, cwd: s.cwd, workspace: s.workspace, command: `tmux attach -t ${JSON.stringify(s.tmux_target)}` } });
    select({ machineId: mid, sessionId: r.id });
  });

  return (
    <>
      <div className="topbar">
        <div className="crumb"><a onClick={() => select({ machineId: mid })}>{m.config.name}</a> / <a className="mono" onClick={() => select({ machineId: mid, workspace: s.workspace || s.cwd })}>{shortPath(s.workspace || s.cwd, home)}</a> /</div>
        <h1>
          <TypeAvatar type={s.type} size={28} />
          {renaming ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ background: 'var(--bg-3)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '2px 6px' }}
              onKeyDown={(e) => { if (e.key === 'Enter') { api.rpc(mid, 'session.rename', { session: s.id, name }).catch(() => undefined); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }} onBlur={() => setRenaming(false)} />
          ) : <span onDoubleClick={() => { setName(s.name); setRenaming(true); }} title="double-click to rename">{s.name}</span>}
          <span className={classNames('badge', live ? sessionTone(s) : s.status === 'exited' && s.exit_code ? 'error' : 'muted')}><span className={classNames('dot', live ? sessionTone(s) : 'muted')} style={{ width: 6, height: 6, boxShadow: 'none', animation: 'none' }} />{s.status}{s.exit_code != null && !live ? ` · code ${s.exit_code}` : ''}</span>
        </h1>
        <div className="spacer" />
        {s.tmux_target && !s.has_pty && <button className="btn" onClick={openTmux}><Icon name="terminal" size={14} /> Open tmux terminal</button>}
        {live && <button className="btn" onClick={stop}><Icon name="stop" size={14} /> Stop</button>}
        {live && <button className="btn danger" onClick={kill}><Icon name="zap" size={14} /> Kill</button>}
        {!s.adopted && !live && <button className="btn primary" onClick={restart}><Icon name="restart" size={14} /> Restart{s.type === 'claude' ? ' (resume)' : ''}</button>}
        {!s.adopted && live && <button className="btn" onClick={() => openModal({ type: 'confirm', title: 'Restart agent', text: `Stop and relaunch ${s.name}?${s.type === 'claude' ? ' Claude Code will resume the same session.' : ''}`, onOk: restart })}><Icon name="restart" size={14} /> Restart</button>}
        {!live && <button className="btn ghost" onClick={remove}><Icon name="trash" size={14} /> Remove</button>}
        {live && s.adopted && <button className="btn ghost" title="stop tracking this process (does not kill it)" onClick={remove}><Icon name="x" size={14} /> Forget</button>}
      </div>
      <div className="agent-hero">
          <div className="card">
            <h3><Icon name="activity" size={13} /> Activity {s.activity?.kind && <span className="sub">· from the {s.activity.kind} transcript</span>}</h3>
            {live || s.activity ? <ActivityCard activity={s.activity} /> : <div className="muted">process exited</div>}
          </div>
          <div className="card">
            <h3><Icon name="list" size={13} /> Process</h3>
            <dl className="kv">
              <dt>PID</dt><dd>{s.pid ?? '–'} · {s.processes.length} process(es){detached ? ` · ${detached} detached` : ''}</dd>
              <dt>Command</dt><dd title={s.command || ''}>{s.command}</dd>
              <dt>Directory</dt><dd title={s.cwd}>{s.cwd}</dd>
              <dt>Usage</dt><dd>CPU {cpu.toFixed(0)}% · RSS {fmtBytes(rss, 0)}{vram ? ` · VRAM ${fmtBytes(vram, 0)}` : ''}</dd>
              <dt>Started</dt><dd>{ago(s.started || s.created)}{s.restarts ? ` · restarted ${s.restarts}×` : ''}{s.ended ? ` · ended ${ago(s.ended)}` : ''}</dd>
            </dl>
          </div>
      </div>
      <div className="tabs" style={{ marginTop: 12 }}>
        {(['terminal', 'activity', 'processes', 'logs', 'git'] as Tab[]).map((t) => (
          <button key={t} className={classNames('tab', tab === t && 'active')} onClick={() => setTab(t)}>
            <Icon name={t === 'terminal' ? 'terminal' : t === 'activity' ? 'layers' : t === 'processes' ? 'list' : t === 'logs' ? 'log' : 'branch'} size={13} />
            {t === 'activity' ? 'Subagents' : t[0].toUpperCase() + t.slice(1)}
            {t === 'activity' && (s.activity?.subagents?.length ? <span className="count">{subs.length}/{s.activity.subagents.length}</span> : null)}
            {t === 'processes' && <span className="count">{s.processes.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'terminal' && (s.has_pty || s.scrollback_bytes > 0 ? (
        <div className="tabpanel"><TerminalView machineId={mid} sessionId={s.id} kind={s.type} readOnly={!s.has_pty} /></div>
      ) : (
        <div className="tabpanel pad"><div className="empty"><Icon name="terminal" size={22} /><div>
          This agent was adopted from an existing process, so its terminal is not attached to Hostler.
          {s.tmux_target ? <> It runs inside tmux (<span className="mono">{s.tmux_target}</span>) — <a style={{ cursor: 'pointer' }} onClick={openTmux}>open a tmux terminal</a>.</> : ' Activity, processes and signals still work.'}
        </div></div></div>
      ))}
      {tab === 'activity' && <div className="tabpanel pad"><SubagentList subagents={s.activity?.subagents || []} /></div>}
      {tab === 'processes' && <div className="tabpanel"><ProcessTree machineId={mid} session={s} /></div>}
      {tab === 'logs' && <div className="tabpanel"><LogsView machineId={mid} sessionId={s.id} /></div>}
      {tab === 'git' && <div className="tabpanel pad"><GitPanel machineId={mid} cwd={s.workspace || s.cwd} /></div>}
    </>
  );
}
