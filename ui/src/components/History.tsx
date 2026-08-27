import React, { useCallback, useContext, useEffect, useState } from 'react';
import type { HistoryEntry, MachineState, SessionInfo } from '@shared/types';
import { AppCtx } from '../App';
import { api } from '../api';
import { ago, fmtBytes, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';

/** Past conversations of a directory, read from the agents' own transcripts on the machine. */
export function useHistory(machineId: string, cwd: string, enabled: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (!enabled) { setEntries(null); return; }
    api.rpc<HistoryEntry[]>(machineId, 'history.list', { cwd, limit: 40 })
      .then((r) => { setEntries(r || []); setError(''); })
      .catch((e: Error) => { setEntries([]); setError(e.message); });
  }, [machineId, cwd, enabled]);
  useEffect(reload, [reload]);
  return { entries, error, reload };
}

/**
 * A conversation must appear once per page: anything an agent listed above is bound to —
 * live, adopted or already finished — is that agent's session, not history. Sessions know
 * their conversation before the transcript is even parsed (resume ids land in meta), so a
 * resumed conversation moves up the moment it is launched.
 */
export function pastOnly(entries: HistoryEntry[] | null | undefined, sessions: SessionInfo[]): HistoryEntry[] {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const s of sessions) {
    const meta = s.meta || {};
    for (const k of [s.activity?.session_id, meta.claude_session_id, meta.session_id, meta.resume_id]) if (k) ids.add(String(k));
    if (s.activity?.transcript) paths.add(s.activity.transcript);
  }
  return (entries || []).filter((e) => !ids.has(e.session_id) && !paths.has(e.path));
}

export function HistoryCard({ machine: m, cwd }: { machine: MachineState; cwd: string }) {
  const connected = m.status === 'connected';
  const { entries, error, reload } = useHistory(m.config.id, cwd, connected);
  const [all, setAll] = useState(false);
  const past = pastOnly(entries, m.sessions);
  const shown = all ? past : past.slice(0, 6);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3><Icon name="history" size={13} /> Past conversations
        <span className="sub">{entries ? `${past.length} transcript(s) not currently open` : 'reading transcripts…'}</span>
        <span className="spacer" />
        {past.length > 6 && <button className="btn sm ghost" onClick={() => setAll(!all)}>{all ? 'show less' : `show all ${past.length}`}</button>}
        <button className="btn sm ghost icon" title="Refresh" disabled={!connected} onClick={reload}><Icon name="refresh" size={13} /></button>
      </h3>
      {error ? <div className="empty small">{/unknown op/.test(error) ? `${m.config.name} still runs an older helper — it updates automatically once no session is running on it.` : error}</div>
        : !connected ? <div className="empty small">not connected</div>
        : entries === null ? <div className="empty small">reading transcripts…</div>
        : past.length === 0 ? <div className="empty small">{entries.length ? 'Every transcript for this directory belongs to an agent that is already open above.' : 'No Claude Code / Codex / OpenCode transcript for this directory yet.'}</div>
        : <HistoryList machine={m} entries={shown} />}
    </div>
  );
}

export function HistoryList({ machine: m, entries, compact, onResumed }: { machine: MachineState; entries: HistoryEntry[]; compact?: boolean; onResumed?: (sessionId: string) => void }) {
  const { select } = useContext(AppCtx);
  const [busy, setBusy] = useState('');
  const resume = async (e: HistoryEntry) => {
    const go = (sid: string) => (onResumed ? onResumed(sid) : select({ machineId: m.config.id, workspace: e.cwd, sessionId: sid }));
    setBusy(e.session_id);
    const spec = {
      type: e.type, name: (e.title || e.prompt || TYPE_LABEL[e.type] || e.type).slice(0, 60),
      cwd: e.cwd, workspace: e.cwd, resume: true, resume_id: e.session_id, cols: 120, rows: 32,
    };
    const r = await api.act('resume', () => api.rpc<SessionInfo>(m.config.id, 'session.create', { spec }));
    setBusy('');
    if (r) go(r.id);
  };
  return (
    <div className="tbl-wrap"><table className="tbl">
      <tbody>
        {entries.map((e) => {
          const text = e.title || e.prompt || `${TYPE_LABEL[e.type] || e.type} session`;
          const detail = e.last_prompt || e.prompt || '';
          return (
            <tr key={`${e.type}:${e.session_id}`} className="clickable" onClick={() => resume(e)}>
              <td style={{ width: 30 }}><TypeAvatar type={e.type} size={26} /></td>
              <td>
                <div className="trunc" style={{ maxWidth: compact ? 380 : 460 }} title={text}>{text}</div>
                <div className="muted small trunc" style={{ maxWidth: compact ? 380 : 460 }} title={detail}>{detail}</div>
              </td>
              <td className="nowrap muted small">
                <span className="badge muted">{TYPE_LABEL[e.type] || e.type}</span>
                {e.branch ? <span className="badge muted" style={{ marginLeft: 4 }}><Icon name="branch" size={10} /> {e.branch}</span> : null}
              </td>
              {!compact && <td className="nowrap muted small" title={e.model || ''}>{e.model || ''}</td>}
              {!compact && <td className="nowrap muted small">{fmtBytes(e.size, 0)}</td>}
              <td className="nowrap muted">{ago(e.mtime)}</td>
              <td className="actions" onClick={(ev) => ev.stopPropagation()}>
                <button className="btn sm ghost" disabled={busy === e.session_id || !e.resumable} onClick={() => resume(e)}>
                  <Icon name="restart" size={13} /> {busy === e.session_id ? 'Resuming…' : 'Resume'}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}
