import React from 'react';
import type { Activity, Subagent } from '@shared/types';
import { activitySummary, agoIso, classNames, fmtDuration } from '../util';
import { Icon } from './icons';

export function ActivityCard({ activity }: { activity?: Activity | null }) {
  const a = activity;
  const sum = activitySummary(a);
  return (
    <div className="activity">
      <div className="status-line">
        <span className={classNames('dot', sum.tone)} />
        <span>{sum.label}</span>
        {a?.age != null && <span className="muted">· updated {fmtDuration(a.age)} ago</span>}
      </div>
      {sum.detail && <div className="detail">{sum.detail}</div>}
      {(a?.status === 'tool' || a?.status === 'thinking') && a.last_text && <div className="detail quiet">last message: {a.last_text}</div>}
      {a && (
        <div className="meta">
          {a.title && <span title="session title"><Icon name="log" size={12} /> {a.title}</span>}
          {a.model && <span><Icon name="bot" size={12} /> {a.model}</span>}
          <span><Icon name="send" size={12} /> {a.turns} turn{a.turns === 1 ? '' : 's'}</span>
          <span><Icon name="terminal" size={12} /> {a.tool_calls} tool call{a.tool_calls === 1 ? '' : 's'}</span>
          {a.usage && (a.usage.input || a.usage.output) ? <span><Icon name="activity" size={12} /> in {fmtK(a.usage.input)} / out {fmtK(a.usage.output)}{a.usage.cache_read ? ` / cache ${fmtK(a.usage.cache_read)}` : ''}</span> : null}
          {a.session_id && <span className="mono" title={a.transcript || ''}>#{a.session_id.slice(0, 8)}</span>}
        </div>
      )}
      {a?.pending_tools && a.pending_tools.length > 1 && (
        <div className="meta">pending: {a.pending_tools.map((t) => t.name).join(', ')}</div>
      )}
    </div>
  );
}

function fmtK(n?: number | null) {
  if (n == null) return '–';
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export function SubagentList({ subagents }: { subagents: Subagent[] }) {
  if (!subagents.length) return <div className="empty"><Icon name="layers" size={22} /><div>No subagents spawned in this session</div></div>;
  const sorted = [...subagents].sort((x, y) => (x.status === y.status ? 0 : x.status === 'running' ? -1 : 1));
  return (
    <div className="subagents">
      {sorted.map((sa) => {
        const s = activitySummary(sa.activity);
        return (
          <div key={sa.id} className={classNames('subagent', sa.status)}>
            <span className={classNames('dot', sa.status === 'running' ? s.tone === 'muted' ? 'busy' : s.tone : 'muted')} />
            <div style={{ minWidth: 0 }}>
              <div className="title">{sa.description || sa.type || sa.id} <span className="badge" style={{ marginLeft: 6 }}>{sa.type || 'subagent'}</span>{sa.async && <span className="badge muted" style={{ marginLeft: 4 }}>async</span>}</div>
              {sa.status === 'running' ? (
                <div className="line" title={s.detail}>{s.label}{s.detail ? ` — ${s.detail}` : ''}</div>
              ) : (
                <div className="line muted" title={sa.activity?.last_text || ''}>completed{sa.activity?.last_text ? ` — ${sa.activity.last_text}` : ''}</div>
              )}
              {sa.activity && <div className="muted small">{sa.activity.tool_calls} tool calls · {sa.activity.turns} turns{sa.activity.model ? ` · ${sa.activity.model}` : ''}</div>}
            </div>
            <div className="when">{agoIso(sa.started || sa.activity?.last_ts)}</div>
          </div>
        );
      })}
    </div>
  );
}
