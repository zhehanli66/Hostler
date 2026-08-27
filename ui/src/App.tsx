import React, { useEffect, useRef, useState } from 'react';
import { api, useAppState, useApiMeta } from './api';
import { Sidebar } from './components/Sidebar';
import { MachineView } from './components/MachineView';
import { AgentView } from './components/AgentView';
import { WorkspaceView } from './components/WorkspaceView';
import { AddMachineModal, NewAgentModal, ConfirmModal, EditMachineModal, InstallToolModal } from './components/modals';
import { Icon } from './components/icons';

export type Selection = { machineId: string; workspace?: string; sessionId?: string } | null;
export type Modal =
  | { type: 'addMachine' }
  | { type: 'editMachine'; machineId: string }
  | { type: 'newAgent'; machineId: string; cwd?: string }
  | { type: 'installTool'; machineId: string; tool: string }
  | { type: 'confirm'; title: string; text: string; danger?: boolean; onOk: () => void }
  | null;

export const AppCtx = React.createContext<{ select: (s: Selection) => void; openModal: (m: Modal) => void }>({ select: () => undefined, openModal: () => undefined });

export function App() {
  const state = useAppState();
  useApiMeta();
  const [sel, setSel] = useState<Selection>(() => {
    const h = location.hash.match(/^#\/m\/([^/]+)(?:\/w\/([^/]+))?(?:\/s\/([^/]+))?/);
    if (h) return { machineId: decodeURIComponent(h[1]), workspace: h[2] ? decodeURIComponent(h[2]) : undefined, sessionId: h[3] ? decodeURIComponent(h[3]) : undefined };
    try { return JSON.parse(localStorage.getItem('hostler_sel') || 'null'); } catch { return null; }
  });
  const [modal, setModal] = useState<Modal>(null);

  useEffect(() => {
    try { localStorage.setItem('hostler_sel', JSON.stringify(sel)); } catch { /* ignore */ }
    const hash = sel ? `#/m/${encodeURIComponent(sel.machineId)}${sel.workspace ? `/w/${encodeURIComponent(sel.workspace)}` : ''}${sel.sessionId ? `/s/${encodeURIComponent(sel.sessionId)}` : ''}` : '';
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  }, [sel]);

  const machine = sel ? state.machines.find((m) => m.config.id === sel.machineId) : undefined;
  const session = machine && sel?.sessionId ? machine.sessions.find((s) => s.id === sel.sessionId) : undefined;

  // a session just created (New Agent, resume, install) is selected before the control plane
  // has broadcast it — give it a moment before deciding it does not exist
  const awaiting = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => { if (sel?.sessionId) awaiting.current = { id: sel.sessionId, until: Date.now() + 5000 }; }, [sel?.sessionId]);

  useEffect(() => {
    if (!state.version) return; // state not received yet — keep the deep-linked / remembered selection
    if (sel && !machine) setSel(null);
    else if (sel?.sessionId && machine && !session && machine.status === 'connected') {
      const a = awaiting.current;
      if (a && a.id === sel.sessionId && Date.now() < a.until) return;
      setSel({ machineId: machine.config.id, workspace: sel.workspace });
    }
  }, [sel, machine, session, state.version]);

  return (
    <AppCtx.Provider value={{ select: setSel, openModal: setModal }}>
      <div className="app">
        <Sidebar state={state} sel={sel} />
        <div className="main">
          {!state.version ? (
            <div className="welcome"><div><div className="hero-logo" style={{ animation: 'pulse 1.4s infinite' }}><Icon name="server" size={26} strokeWidth={2.2} /></div><div className="muted">Connecting to the control plane…</div></div></div>
          ) : machine && session ? (
            <AgentView machine={machine} session={session} />
          ) : machine && sel?.workspace ? (
            <WorkspaceView machine={machine} path={sel.workspace} workspace={state.workspaces.find((w) => w.machineId === machine.config.id && w.path === sel.workspace)} />
          ) : machine ? (
            <MachineView machine={machine} workspaces={state.workspaces.filter((w) => w.machineId === machine.config.id)} />
          ) : (
            <Welcome hasMachines={state.machines.length > 0} />
          )}
        </div>
        {modal?.type === 'addMachine' && <AddMachineModal onClose={() => setModal(null)} />}
        {modal?.type === 'editMachine' && <EditMachineModal machine={state.machines.find((m) => m.config.id === modal.machineId)!} onClose={() => setModal(null)} />}
        {modal?.type === 'newAgent' && <NewAgentModal machine={state.machines.find((m) => m.config.id === modal.machineId)!} workspaces={state.workspaces.filter((w) => w.machineId === modal.machineId)} cwd={modal.cwd} onClose={() => setModal(null)} onCreated={(sid) => { setModal(null); setSel({ machineId: modal.machineId, sessionId: sid }); }} />}
        {modal?.type === 'installTool' && <InstallToolModal machine={state.machines.find((m) => m.config.id === modal.machineId)!} tool={modal.tool} onClose={() => setModal(null)} onCreated={(sid) => { setModal(null); setSel({ machineId: modal.machineId, sessionId: sid }); }} />}
        {modal?.type === 'confirm' && <ConfirmModal title={modal.title} text={modal.text} danger={modal.danger} onOk={() => { setModal(null); modal.onOk(); }} onClose={() => setModal(null)} />}
        <Toasts />
      </div>
    </AppCtx.Provider>
  );
}

function Toasts() {
  useApiMeta();
  return (
    <div className="toasts">
      {api.toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.text}</div>)}
      {!api.connected && <div className="toast error">Control plane disconnected — reconnecting…</div>}
    </div>
  );
}

function Welcome({ hasMachines }: { hasMachines: boolean }) {
  const { openModal } = React.useContext(AppCtx);
  return (
    <div className="welcome">
      <div>
        <div className="hero-logo"><Icon name="server" size={26} strokeWidth={2.2} /></div>
        <h2>Native coding agents, one control center</h2>
        <p>Connect servers, workstations and Jetsons over SSH and run the real Claude Code / Codex / OpenCode CLIs on them. This computer is the control plane; agents keep running when you close it.</p>
        <div className="steps">
          <div className="step"><div className="n"><Icon name="server" size={14} /></div><b>Add a machine</b><span>Pick a host from ~/.ssh/config or type an address. A tiny Python helper is deployed automatically.</span></div>
          <div className="step"><div className="n"><Icon name="folder" size={14} /></div><b>Pick a directory</b><span>Workspaces are just directories on a machine — browse and choose one.</span></div>
          <div className="step"><div className="n"><Icon name="bot" size={14} /></div><b>Launch or adopt</b><span>Start a new agent in a persistent terminal, or adopt one that is already running.</span></div>
        </div>
        <button className="btn primary" onClick={() => openModal({ type: 'addMachine' })}><Icon name="plus" size={14} /> Add Machine</button>
        {hasMachines && <div className="muted small" style={{ marginTop: 12 }}>or select a machine on the left</div>}
      </div>
    </div>
  );
}
