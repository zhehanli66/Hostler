import React, { useEffect, useState } from 'react';
import type { GitStatus } from '@shared/types';
import { api } from '../api';
import { classNames } from '../util';
import { Icon } from './icons';

export function GitPanel({ machineId, cwd }: { machineId: string; cwd: string }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path?: string; staged: boolean; text: string } | null>(null);
  const load = () => api.rpc<GitStatus>(machineId, 'git.status', { cwd }).then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [machineId, cwd]);
  const showDiff = (path?: string, staged = false) => api.rpc(machineId, 'git.diff', { cwd, path, staged }).then((r) => setDiff({ path, staged, text: r.diff || r.error || '(no diff)' })).catch((e) => setDiff({ path, staged, text: e.message }));
  if (err) return <div className="empty">{err}</div>;
  if (!st) return <div className="empty">loading…</div>;
  if (!st.available || !st.repo) return <div className="empty"><Icon name="branch" size={22} /><div>{st.error || 'not a git repository'}</div><span className="mono muted">{cwd}</span></div>;
  const b = st.branch!;
  return (
    <div className="grid2" style={{ gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.4fr)' }}>
      <div>
        <div className="card" style={{ marginBottom: 12 }}>
          <h3><Icon name="branch" size={13} /> Branch <span className="spacer" /><button className="btn sm ghost" onClick={load}><Icon name="refresh" size={13} /> refresh</button></h3>
          <dl className="kv">
            <dt>HEAD</dt><dd>{b.head || '(detached)'}</dd>
            <dt>Upstream</dt><dd>{b.upstream || '–'}{b.upstream ? ` · ↑${b.ahead} ↓${b.behind}` : ''}</dd>
            <dt>Repo</dt><dd title={st.top}>{st.top}</dd>
            <dt>Changes</dt><dd>{st.file_count} file(s){st.diff ? ` · ${st.diff}` : ''}{st.diff_staged ? ` · staged: ${st.diff_staged}` : ''}</dd>
          </dl>
        </div>
        <div className="card" style={{ marginBottom: 12 }}>
          <h3><Icon name="log" size={13} /> Changed files <span className="spacer" /><button className="btn sm ghost" onClick={() => showDiff(undefined, false)}>full diff</button><button className="btn sm ghost" onClick={() => showDiff(undefined, true)}>staged</button></h3>
          {st.files?.length ? (
            <div className="git-files">
              {st.files.map((f) => (
                <div key={f.path} className="f" onClick={() => showDiff(f.path, f.staged && !f.unstaged)} title={f.path}>
                  <span className={classNames('xy', f.untracked && 'u', f.conflict && 'c')}>{f.xy}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
                </div>
              ))}
            </div>
          ) : <div className="muted">working tree clean</div>}
        </div>
        <div className="card">
          <h3><Icon name="clock" size={13} /> Recent commits</h3>
          {st.commits?.map((c) => (
            <div key={c.hash} className="commit"><span className="h">{c.hash}</span><span className="s">{c.subject}</span><span className="m">{c.author} · {c.when}</span></div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3><Icon name="activity" size={13} /> Diff {diff?.path && <span className="mono sub">{diff.path}{diff.staged ? ' (staged)' : ''}</span>}</h3>
        {diff ? <pre className="diff">{diff.text.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff') || l.startsWith('index') || l.startsWith('+++') || l.startsWith('---') ? 'hdr' : ''}>{l || ' '}</div>)}</pre> : <div className="muted">select a file to see its diff</div>}
      </div>
    </div>
  );
}
