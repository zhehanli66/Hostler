import React, { useEffect, useState } from 'react';
import type { AgentType, FsList, MachineState, SshHostEntry, WorkspaceConfig } from '@shared/types';
import { api, useAppState } from '../api';
import { classNames, shortPath, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';

export function Modal({ title, children, footer, onClose, wide }: { title: string; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { width: 'min(820px, 94vw)' } : undefined}>
        <header>{title}<span className="spacer" /><button className="btn ghost sm icon" onClick={onClose}><Icon name="x" size={14} /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, text, danger, onOk, onClose }: { title: string; text: string; danger?: boolean; onOk: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={classNames('btn', danger ? 'danger' : 'primary')} onClick={onOk}>OK</button></>}>
      <div>{text}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- machines

interface MachineForm { name: string; transport: 'ssh' | 'local'; host: string; port: string; user: string; identityFile: string; password: string; savePassword: boolean; proxyJump: string; pythonPath: string }
const emptyForm: MachineForm = { name: '', transport: 'ssh', host: '', port: '', user: '', identityFile: '', password: '', savePassword: false, proxyJump: '', pythonPath: '' };

function MachineFields({ f, set, hosts }: { f: MachineForm; set: (p: Partial<MachineForm>) => void; hosts: SshHostEntry[] }) {
  const caps = useAppState().capabilities;
  const canSave = caps.secretStorage !== 'none';
  return (
    <>
      <div className="choice">
        <button className={classNames(f.transport === 'ssh' && 'active')} onClick={() => set({ transport: 'ssh' })}><Icon name="server" size={18} />SSH<small>remote server / workstation / Jetson</small></button>
        <button className={classNames(f.transport === 'local' && 'active')} onClick={() => set({ transport: 'local' })}><Icon name="monitor" size={18} />Local<small>this computer</small></button>
      </div>
      {f.transport === 'ssh' && hosts.length > 0 && (
        <div className="field">
          <label>From ~/.ssh/config</label>
          <select value="" onChange={(e) => { const h = hosts.find((x) => x.host === e.target.value); if (h) set({ host: h.host, name: f.name || h.host, user: h.user || '', port: h.port ? String(h.port) : '', identityFile: h.identityFile || '', proxyJump: h.proxyJump || '' }); }}>
            <option value="">pick a host…</option>
            {hosts.map((h) => <option key={h.host} value={h.host}>{h.host}{h.hostName ? ` (${h.user ? h.user + '@' : ''}${h.hostName})` : ''}</option>)}
          </select>
        </div>
      )}
      <div className="fields-2">
        <div className="field"><label>Name</label><input value={f.name} placeholder="gpu-box" onChange={(e) => set({ name: e.target.value })} /></div>
        {f.transport === 'ssh' && <div className="field"><label>Host / alias</label><input value={f.host} placeholder="192.168.1.20 or ssh-config alias" onChange={(e) => set({ host: e.target.value })} /></div>}
      </div>
      {f.transport === 'ssh' && (
        <>
          <div className="fields-2">
            <div className="field"><label>User</label><input value={f.user} placeholder={'(from ssh config / current user)'} onChange={(e) => set({ user: e.target.value })} /></div>
            <div className="field"><label>Port</label><input value={f.port} placeholder="22" onChange={(e) => set({ port: e.target.value })} /></div>
          </div>
          <div className="fields-2">
            <div className="field"><label>Identity file</label><input value={f.identityFile} placeholder="~/.ssh/id_ed25519 (agent + default keys are tried automatically)" onChange={(e) => set({ identityFile: e.target.value })} /></div>
            <div className="field"><label>ProxyJump</label><input value={f.proxyJump} placeholder="user@bastion (optional)" onChange={(e) => set({ proxyJump: e.target.value })} /></div>
          </div>
          <div className="fields-2">
            <div className="field"><label>Password (optional)</label><input type="password" value={f.password} placeholder="used if keys fail; kept in memory unless saved" onChange={(e) => set({ password: e.target.value })} /></div>
            <div className="field"><label>Remote python</label><input value={f.pythonPath} placeholder="python3 (auto-detected)" onChange={(e) => set({ pythonPath: e.target.value })} /></div>
          </div>
          <div className="field row"><input type="checkbox" id="savepw" disabled={!canSave} checked={f.savePassword && canSave} onChange={(e) => set({ savePassword: e.target.checked })} />
            <label htmlFor="savepw">{caps.secretStorage === 'keychain' ? 'Remember password (encrypted with the OS keychain)' : caps.desktop ? 'Remember password — unavailable: no OS keyring found (libsecret / kwallet); the password is kept in memory for this session only' : 'Remember password — needs the desktop app (OS keychain); in browser mode the password is kept in memory only'}</label></div>
          <div className="field"><div className="hint">Tip: after the first password login, use “Set up key login” on the machine page to install your public key and stop using the password altogether.</div></div>
        </>
      )}
    </>
  );
}

function formToConfig(f: MachineForm) {
  return { name: f.name || f.host || (f.transport === 'local' ? 'This computer' : ''), transport: f.transport, host: f.host, port: f.port ? parseInt(f.port, 10) : undefined, user: f.user, identityFile: f.identityFile, password: f.password || undefined, savePassword: f.savePassword, proxyJump: f.proxyJump, pythonPath: f.pythonPath };
}

export function AddMachineModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<MachineForm>(emptyForm);
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.call<SshHostEntry[]>('ssh.hosts').then(setHosts).catch(() => undefined); }, []);
  const submit = async () => {
    if (f.transport === 'ssh' && !f.host) { setErr('host is required'); return; }
    setBusy(true);
    try { await api.call('machine.add', { config: formToConfig(f) }); onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add Machine" onClose={onClose} footer={<><span className="err">{err}</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}><Icon name="link" size={14} /> Add & Connect</button></>}>
      <MachineFields f={f} set={(p) => setF({ ...f, ...p })} hosts={hosts} />
      <div className="muted small">On first connect a single-file Python helper (~/.hostler/hostler_helper.py, stdlib only) is uploaded and started as a daemon. It keeps PTYs alive across disconnects; nothing else is installed.</div>
    </Modal>
  );
}

export function EditMachineModal({ machine, onClose }: { machine: MachineState; onClose: () => void }) {
  const c = machine.config;
  const [f, setF] = useState<MachineForm>({ name: c.name, transport: c.transport, host: c.host || '', port: c.port ? String(c.port) : '', user: c.user || '', identityFile: c.identityFile || '', password: '', savePassword: !!c.savePassword, proxyJump: c.proxyJump || '', pythonPath: c.pythonPath || '' });
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.call<SshHostEntry[]>('ssh.hosts').then(setHosts).catch(() => undefined); }, []);
  const save = async () => {
    try {
      const patch: any = formToConfig(f);
      if (!f.password) delete patch.password;
      await api.call('machine.update', { machineId: c.id, patch });
      onClose();
    } catch (e: any) { setErr(e.message); }
  };
  const remove = async () => {
    if (!confirm(`Remove machine "${c.name}" from Hostler? Running agents on it are NOT stopped.`)) return;
    await api.call('machine.remove', { machineId: c.id });
    onClose();
  };
  return (
    <Modal title={`Edit ${c.name}`} onClose={onClose} footer={<><button className="btn danger" onClick={remove}>Remove machine</button><span className="err">{err}</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <MachineFields f={f} set={(p) => setF({ ...f, ...p })} hosts={hosts} />
      <div className="field row"><input type="checkbox" id="autoc" checked={c.autoConnect !== false} onChange={(e) => api.call('machine.update', { machineId: c.id, patch: { autoConnect: e.target.checked } })} /><label htmlFor="autoc">Connect automatically on startup</label></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- new agent

export function DirPicker({ machineId, value, onChange, home }: { machineId: string; value: string; onChange: (p: string) => void; home?: string | null }) {
  const [list, setList] = useState<FsList | null>(null);
  const [input, setInput] = useState(value);
  const [hidden, setHidden] = useState(false);
  const load = (p: string) => api.rpc<FsList>(machineId, 'fs.list', { path: p, hidden }).then((l) => { setList(l); if (!l.error) { onChange(l.path); setInput(l.path); } }).catch((e) => setList({ path: p, parent: null, entries: [], error: e.message }));
  useEffect(() => { load(value || home || '~'); }, [machineId, hidden]);
  return (
    <div className="dirpicker">
      <div className="path">
        <button className="btn sm ghost icon" disabled={!list?.parent} onClick={() => list?.parent && load(list.parent)} title="parent directory"><Icon name="arrowUp" size={13} /></button>
        <button className="btn sm ghost icon" onClick={() => load(home || '~')} title="home"><Icon name="home" size={13} /></button>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(input); }} onBlur={() => { if (input !== list?.path) load(input); }} />
        {list?.git && <span className="git">git</span>}
        <label className="row-flex small muted"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />hidden</label>
      </div>
      <div className="list">
        {list?.error && <div className="empty">{list.error}</div>}
        {list?.entries.filter((e) => e.dir).map((e) => (
          <div key={e.name} className="entry" onDoubleClick={() => load(list.path.replace(/\/$/, '') + '/' + e.name)} onClick={() => { const p = list.path.replace(/\/$/, '') + '/' + e.name; setInput(p); onChange(p); }} title="click to select, double-click to enter">
            <Icon name="folder" size={13} /><span style={{ flex: 1 }}>{e.name}</span>{e.git && <span className="git">git</span>}
          </div>
        ))}
        {list && !list.error && list.entries.filter((e) => e.dir).length === 0 && <div className="empty">no subdirectories</div>}
      </div>
    </div>
  );
}

export function NewAgentModal({ machine, workspaces, cwd, onClose, onCreated }: { machine: MachineState; workspaces: WorkspaceConfig[]; cwd?: string; onClose: () => void; onCreated: (sid: string) => void }) {
  const tools = machine.hello?.tools || {};
  const [type, setType] = useState<AgentType>(tools.claude ? 'claude' : tools.codex ? 'codex' : tools.opencode ? 'opencode' : 'shell');
  const [dir, setDir] = useState(cwd || workspaces[0]?.path || machine.hello?.home || '~');
  const [name, setName] = useState('');
  const [args, setArgs] = useState('');
  const [command, setCommand] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const home = machine.hello?.home;
  const submit = async () => {
    if (type === 'custom' && !command.trim()) { setErr('command is required'); return; }
    setBusy(true);
    try {
      const spec = { type, name: name.trim() || undefined, cwd: dir, workspace: dir, args: args.trim() || undefined, command: type === 'custom' ? command : undefined, cols: 120, rows: 32 };
      const r = await api.rpc(machine.config.id, 'session.create', { spec });
      onCreated(r.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const typeAvail = (t: AgentType) => t === 'shell' || t === 'custom' || !!tools[t];
  return (
    <Modal title={`New Agent on ${machine.config.name}`} onClose={onClose} wide footer={<><span className="err">{err}</span><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}><Icon name="play" size={14} /> Launch</button></>}>
      <div className="choice">
        {(['claude', 'codex', 'opencode', 'shell', 'custom'] as AgentType[]).map((t) => (
          <button key={t} className={classNames(type === t && 'active')} disabled={!typeAvail(t)} onClick={() => setType(t)} title={typeAvail(t) ? '' : `${t} not found on ${machine.config.name}`}>
            <TypeAvatar type={t} size={26} />{TYPE_LABEL[t]}<small>{t === 'claude' ? 'claude --session-id …' : t === 'codex' ? 'codex' : t === 'opencode' ? 'opencode' : t === 'shell' ? 'login shell' : 'any command'}{!typeAvail(t) ? ' · not installed' : ''}</small>
          </button>
        ))}
      </div>
      <div className="field">
        <label>Directory (workspace)</label>
        {workspaces.length > 0 && <div className="wslist">{workspaces.map((w) => <span key={w.id} className={classNames('chip', w.path === dir && 'active')} onClick={() => setDir(w.path)}>{shortPath(w.path, home)}</span>)}</div>}
        <DirPicker machineId={machine.config.id} value={dir} onChange={setDir} home={home} />
      </div>
      <div className="fields-2">
        <div className="field"><label>Name</label><input value={name} placeholder={`${TYPE_LABEL[type]} in ${shortPath(dir, home)}`} onChange={(e) => setName(e.target.value)} /></div>
        {type !== 'custom' && type !== 'shell' && <div className="field"><label>Extra CLI args</label><input value={args} placeholder={type === 'claude' ? '--model opus  --permission-mode acceptEdits …' : type === 'codex' ? '--full-auto  -m o3 …' : '…'} onChange={(e) => setArgs(e.target.value)} /></div>}
        {type === 'custom' && <div className="field"><label>Command</label><input value={command} placeholder="python train.py --epochs 10" onChange={(e) => setCommand(e.target.value)} /></div>}
      </div>
      <div className="muted small">The command runs in a persistent PTY through your login shell on the machine (so PATH, nvm, auth and MCP config are exactly what you get in a normal terminal). It keeps running when you close this app or lose the SSH connection.</div>
    </Modal>
  );
}
