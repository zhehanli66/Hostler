import React, { useContext, useEffect, useState } from 'react';
import type { DiscoveredProcess, MachineState, WorkspaceConfig } from '@shared/types';
import { AppCtx } from '../App';
import { SessionTable } from './SessionTable';
import { Icon, Sparkline, TypeAvatar } from './icons';
import { api, useAppState } from '../api';
import { ago, classNames, fmtBytes, fmtDuration, pct, sessionTone, shortPath, TYPE_LABEL } from '../util';

export function MachineView({ machine: m, workspaces }: { machine: MachineState; workspaces: WorkspaceConfig[] }) {
  const { openModal, select } = useContext(AppCtx);
  const r = m.resources;
  const home = m.hello?.home;
  const connected = m.status === 'connected';
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    if (!showLog) return;
    let alive = true;
    const tick = () => api.call<string[]>('machine.log', { machineId: m.config.id }).then((l) => alive && setLog(l)).catch(() => undefined);
    tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [showLog, m.config.id]);

  const groups = groupByWorkspace(m, workspaces);
  const hist = m.history || [];
  return (
    <>
      <div className="topbar">
        <h1>
          <span className={classNames('dot', m.status)} />
          {m.config.name}
          <span className="sub">{m.config.transport === 'local' ? 'local' : `${m.config.user ? m.config.user + '@' : ''}${m.config.host || ''}`}{m.hello ? ` · ${m.hello.hostname} · ${m.hello.os || ''} ${m.hello.arch || ''}` : ''}</span>
        </h1>
        <div className="spacer" />
        {connected ? (
          <button className="btn" onClick={() => api.call('machine.disconnect', { machineId: m.config.id })}><Icon name="unlink" size={14} /> Disconnect</button>
        ) : (
          <button className="btn" disabled={m.status === 'connecting' || m.status === 'deploying'} onClick={() => api.call('machine.connect', { machineId: m.config.id })}><Icon name="link" size={14} /> {m.status === 'connecting' ? 'Connecting…' : m.status === 'deploying' ? 'Deploying helper…' : 'Connect'}</button>
        )}
        <button className="btn" onClick={() => setShowLog(!showLog)}><Icon name="log" size={14} /> Log</button>
        <button className="btn icon" title="Machine settings" onClick={() => openModal({ type: 'editMachine', machineId: m.config.id })}><Icon name="settings" size={14} /></button>
        <button className="btn primary" disabled={!connected} onClick={() => openModal({ type: 'newAgent', machineId: m.config.id })}><Icon name="plus" size={14} /> New Agent</button>
      </div>
      <div className="content">
        {m.needsPassword ? <PasswordPrompt m={m} /> : m.error && <div className="banner error"><Icon name="alert" size={15} /><div><b>Connection problem:</b> {m.error}</div></div>}
        {connected && m.config.transport === 'ssh' && (m.authMethod === 'password' || m.authMethod === 'keyboard-interactive') && <KeyLoginBanner m={m} />}
        {m.helperUpgradePending && <div className="banner warn"><Icon name="alert" size={15} /><div>Helper update to {m.helperUpgradePending} is pending: it will be applied automatically when no session is running (running sessions would lose their PTY).</div></div>}
        {showLog && <div className="card" style={{ marginBottom: 14 }}><h3><Icon name="log" size={13} /> Connection log</h3><div className="log-box">{log.join('\n') || '(empty)'}</div></div>}

        <div className="card" style={{ marginBottom: 14 }}>
          <h3><Icon name="cpu" size={13} /> Resources {m.lastUpdate && <span className="sub">· updated {fmtDuration((Date.now() - m.lastUpdate) / 1000)} ago</span>}</h3>
          {r ? (
            <div className="gauges">
              <Gauge icon="cpu" label="CPU" value={`${r.cpu_pct.toFixed(0)}%`} sub={`${r.cores} cores · load ${r.load[0]}`} p={r.cpu_pct} spark={hist.map((h) => h.cpu)} />
              <Gauge icon="memory" label="RAM" value={fmtBytes(r.mem_used, 1)} sub={`of ${fmtBytes(r.mem_total, 0)}`} p={pct(r.mem_used, r.mem_total)} cls="mem" spark={hist.map((h) => h.mem)} sparkColor="#a78bfa" />
              {r.swap_total > 0 && <Gauge icon="memory" label="Swap" value={fmtBytes(r.swap_used)} sub={`of ${fmtBytes(r.swap_total, 0)}`} p={pct(r.swap_used, r.swap_total)} cls="mem" />}
              {r.gpus.map((g, i) => (
                <React.Fragment key={g.index}>
                  <Gauge icon="gpu" label={`GPU ${g.index}`} value={g.util == null ? 'n/a' : `${g.util.toFixed(0)}%`} sub={`${g.name}${g.temp != null ? ` · ${g.temp}°C` : ''}${g.power != null ? ` · ${g.power.toFixed(0)}W` : ''}`} p={g.util ?? 0} cls="gpu" spark={i === 0 ? hist.map((h) => h.gpu) : undefined} sparkColor="#3ecf8e" />
                  <Gauge icon="gpu" label={g.shared ? `Mem (shared) ${g.index}` : `VRAM ${g.index}`} value={fmtBytes(g.mem_used)} sub={`of ${fmtBytes(g.mem_total, 0)}`} p={pct(g.mem_used, g.mem_total)} cls="gpu" spark={i === 0 ? hist.map((h) => h.vram) : undefined} sparkColor="#f6b64b" />
                </React.Fragment>
              ))}
              {r.disk && <Gauge icon="disk" label="Disk" value={fmtBytes(r.disk.total - r.disk.free, 0)} sub={`of ${fmtBytes(r.disk.total, 0)} (${r.disk.path})`} p={pct(r.disk.total - r.disk.free, r.disk.total)} />}
              <Gauge icon="clock" label="Uptime" value={fmtDuration(r.uptime)} sub={m.hello ? `helper ${m.hello.version}${m.hello.subreaper ? '' : ' · no subreaper'}` : ''} p={0} />
            </div>
          ) : <div className="empty">{connected ? 'waiting for data…' : 'not connected'}</div>}
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <h3><Icon name="bot" size={13} /> Agents by workspace <span className="sub">{m.sessions.length} agent(s) in {groups.length} workspace(s)</span><span className="spacer" />
            {m.sessions.some((s) => s.status === 'exited' || s.status === 'lost') && <button className="btn sm ghost" onClick={() => m.sessions.filter((s) => s.status === 'exited' || s.status === 'lost').forEach((s) => api.rpc(m.config.id, 'session.remove', { session: s.id }).catch(() => undefined))}>clear finished</button>}
          </h3>
          {groups.length === 0 ? (
            <div className="empty"><Icon name="bot" size={22} /><div>No agents on this machine.</div>{connected && <button className="btn sm primary" onClick={() => openModal({ type: 'newAgent', machineId: m.config.id })}><Icon name="plus" size={13} /> New Agent</button>}</div>
          ) : groups.map((g) => (
            <WorkspaceGroup key={g.path} m={m} path={g.path} name={g.name} pinned={g.pinned} sessions={g.sessions} home={home} connected={connected} />
          ))}
        </div>

        <div>
          <div className="card">
            <h3><Icon name="eye" size={13} /> Unmanaged agent processes <span className="sub">running outside Hostler</span><span className="spacer" /><button className="btn sm ghost" disabled={!connected} onClick={() => api.rpc(m.config.id, 'discover')}><Icon name="refresh" size={13} /> rescan</button></h3>
            {m.discovered.length === 0 ? <div className="empty small">None found (scans for claude / codex / opencode processes of your user)</div> : (
              <div className="tbl-wrap"><table className="tbl">
                <thead><tr><th>Process</th><th>Directory / args</th><th>Started</th><th></th></tr></thead>
                <tbody>
                  {m.discovered.map((d) => <DiscoveredRow key={d.pid} m={m} d={d} home={home} onAdopted={(sid) => select({ machineId: m.config.id, sessionId: sid })} />)}
                </tbody>
              </table></div>
            )}
          </div>
        </div>
        {m.hello && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3><Icon name="server" size={13} /> Machine info</h3>
            <dl className="kv">
              <dt>Host</dt><dd>{m.hello.hostname} · {m.hello.user} · {m.hello.os} · {m.hello.arch}</dd>
              <dt>Helper</dt><dd>v{m.hello.version} pid {m.hello.pid} · python {m.hello.python} · {m.hello.sock}</dd>
              <dt>Tools</dt><dd>{Object.entries(m.hello.tools).map(([k, v]) => `${k}: ${v ? '✓' : '✗'}`).join('  ')}</dd>
              <dt>GPU</dt><dd>{m.hello.gpu_kind || 'none detected'}</dd>
            </dl>
          </div>
        )}
      </div>
    </>
  );
}

function PasswordPrompt({ m }: { m: MachineState }) {
  const caps = useAppState().capabilities;
  const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pw) return;
    setBusy(true);
    await api.act('connect', () => api.call('machine.connect', { machineId: m.config.id, password: pw, remember }));
    setPw(''); setBusy(false);
  };
  const canRemember = caps.secretStorage !== 'none';
  return (
    <div className="banner warn" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Icon name="alert" size={15} />
      <div style={{ flex: 1, minWidth: 220 }}><b>Password needed</b> for {m.config.user ? m.config.user + '@' : ''}{m.config.host}{m.error && !/password is needed/.test(m.error) ? ` — ${m.error}` : ''}</div>
      <input type="password" autoFocus value={pw} placeholder="SSH password" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        style={{ background: 'var(--bg)', border: '1px solid var(--border-2)', borderRadius: 8, height: 30, padding: '0 10px', color: 'var(--fg)', width: 200 }} />
      <label className="row-flex small" title={canRemember ? 'stored encrypted with the OS keychain' : caps.desktop ? 'no OS keyring found (libsecret / kwallet) — the password stays in memory for this session' : 'saving passwords needs the desktop app (OS keychain); in browser mode it stays in memory'} style={{ color: 'var(--fg-2)' }}>
        <input type="checkbox" disabled={!canRemember} checked={remember && canRemember} onChange={(e) => setRemember(e.target.checked)} /> remember{canRemember ? ' (keychain)' : ''}
      </label>
      <button className="btn primary sm" disabled={busy || !pw} onClick={submit}><Icon name="link" size={13} /> Connect</button>
    </div>
  );
}

function KeyLoginBanner({ m }: { m: MachineState }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    const r = await api.act('set up key login', () => api.call('machine.installKey', { machineId: m.config.id }));
    setBusy(false);
    if (r) {
      setDone(r.verified ? `Key login works (${r.identityFile}). The password has been forgotten.` : `Key ${r.added ? 'installed' : 'was already present'}, but key authentication did not succeed — check the server's sshd settings (PubkeyAuthentication, AuthorizedKeysFile).`);
      api.toast(r.verified ? 'info' : 'warn', r.verified ? 'Key login set up; password no longer needed' : 'Key installed but not accepted by the server');
    }
  };
  if (done) return <div className="banner warn" style={{ alignItems: 'center' }}><Icon name="check" size={15} /><div>{done}</div></div>;
  return (
    <div className="banner warn" style={{ alignItems: 'center' }}>
      <Icon name="alert" size={15} />
      <div style={{ flex: 1 }}><b>Connected with a password.</b> Install your public key on this machine (like <span className="mono">ssh-copy-id</span>) so future connections use key login and no password has to be kept.</div>
      <button className="btn primary sm" disabled={busy} onClick={run}><Icon name="zap" size={13} /> {busy ? 'Setting up…' : 'Set up key login'}</button>
    </div>
  );
}

type Group = { path: string; name: string; pinned: boolean; sessions: MachineState['sessions'] };

function groupByWorkspace(m: MachineState, workspaces: WorkspaceConfig[]): Group[] {
  const map = new Map<string, Group>();
  for (const w of workspaces) map.set(w.path, { path: w.path, name: w.name, pinned: true, sessions: [] });
  for (const s of m.sessions) {
    const k = s.workspace || s.cwd;
    if (!map.has(k)) map.set(k, { path: k, name: k.split('/').filter(Boolean).pop() || k, pinned: false, sessions: [] });
    map.get(k)!.sessions.push(s);
  }
  const live = (g: Group) => g.sessions.filter((s) => s.status === 'running' || s.status === 'adopted').length;
  return [...map.values()].filter((g) => g.sessions.length > 0 || g.pinned).sort((a, b) => live(b) - live(a) || b.sessions.length - a.sessions.length || a.path.localeCompare(b.path));
}

function WorkspaceGroup({ m, path, name, pinned, sessions, home, connected }: { m: MachineState; path: string; name: string; pinned: boolean; sessions: MachineState['sessions']; home?: string | null; connected: boolean }) {
  const { openModal, select } = useContext(AppCtx);
  const [open, setOpen] = useState(true);
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'adopted');
  const busy = live.filter((s) => sessionTone(s) === 'busy').length;
  return (
    <div className="ws-group">
      <div className="ws-head">
        <span className="caret" onClick={() => setOpen(!open)}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /></span>
        <span className={classNames('dot', busy ? 'busy' : live.length ? 'running' : 'muted')} />
        <a className="ws-name" onClick={() => select({ machineId: m.config.id, workspace: path })} title={path}><Icon name="folder" size={13} /> {name}</a>
        <span className="ws-path" title={path}>{shortPath(path, home)}</span>
        {!pinned && <span className="badge muted" title="directory of a running agent, not pinned as a workspace">unpinned</span>}
        <span className="muted small">{live.length} live{busy ? ` · ${busy} busy` : ''}{sessions.length - live.length ? ` · ${sessions.length - live.length} finished` : ''}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!connected} onClick={() => openModal({ type: 'newAgent', machineId: m.config.id, cwd: path })}><Icon name="plus" size={13} /> New Agent</button>
      </div>
      {open && <SessionTable machine={m} sessions={sessions} home={home} showDirectory={false} onOpen={(sid) => select({ machineId: m.config.id, workspace: path, sessionId: sid })} empty={<div className="empty small">no agents yet</div>} />}
    </div>
  );
}

function Gauge({ icon, label, value, sub, p, cls, spark, sparkColor }: { icon: 'cpu' | 'memory' | 'gpu' | 'disk' | 'clock'; label: string; value: string; sub?: string; p: number; cls?: string; spark?: number[]; sparkColor?: string }) {
  return (
    <div className="gauge">
      {spark && spark.length > 1 && <Sparkline values={spark} width={84} height={28} color={sparkColor || 'var(--accent)'} />}
      <div className="label"><span><Icon name={icon} size={12} /> {label}</span><span>{p > 0 ? `${p.toFixed(0)}%` : ''}</span></div>
      <div className="value">{value}</div>
      <div className={classNames('bar', cls, p > 90 ? 'crit' : p > 75 ? 'warn' : '')}><i style={{ width: `${Math.min(100, p)}%` }} /></div>
      {sub && <div className="sub" title={sub}>{sub}</div>}
    </div>
  );
}

function DiscoveredRow({ m, d, home, onAdopted }: { m: MachineState; d: DiscoveredProcess; home?: string | null; onAdopted: (sid: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <tr style={d.background ? { opacity: 0.6 } : undefined}>
      <td className="nowrap"><span className="name-cell"><TypeAvatar type={d.type} size={22} /><span><span className="t">{TYPE_LABEL[d.type] || d.type}</span><span className="s mono">pid {d.pid}{d.tmux_target ? ' · tmux' : ''}</span></span></span></td>
      <td style={{ maxWidth: 190 }}>
        <div className="mono trunc" title={d.cwd || ''}>{shortPath(d.cwd, home) || '?'}</div>
        <div className="mono trunc muted small" title={d.cmd}>{d.args || ''}{d.background ? ' (background/server process)' : ''}</div>
      </td>
      <td className="nowrap muted">{ago(d.started)}</td>
      <td className="actions"><button className="btn sm primary" disabled={busy} onClick={async () => { setBusy(true); const r = await api.act('adopt', () => api.rpc(m.config.id, 'adopt', { pid: d.pid })); setBusy(false); if (r?.id) onAdopted(r.id); }}><Icon name="plus" size={12} /> Adopt</button></td>
    </tr>
  );
}
