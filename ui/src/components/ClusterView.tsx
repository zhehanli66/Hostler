import React, { useContext, useEffect, useState } from 'react';
import type { ClusterJobDetail, ClusterPartition, ClusterStatus, MachineState, SessionInfo } from '@shared/types';
import { AppCtx } from '../App';
import { api } from '../api';
import { classNames, fmtBytes, shq } from '../util';
import { Icon } from './icons';

/** Poll the scheduler for as long as the view is on screen. */
export function useCluster(machineId: string, enabled: boolean, everyMs = 20000) {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (!enabled) return;
    setBusy(true);
    api.rpc<ClusterStatus>(machineId, 'cluster.status')
      .then((r) => { setStatus(r); setError(''); })
      .catch((e: Error) => setError(e.message))
      .then(() => setBusy(false));
  };
  useEffect(() => {
    if (!enabled) return;
    load();
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [machineId, enabled, everyMs]);
  return { status, error, busy, reload: load };
}

/** "931 GB" -> "931G": the tile meters have room for a number and a unit letter */
const compactBytes = (n: number) => fmtBytes(n, 0).replace(/ ([KMGT])B$/, '$1');

const jobTone = (state: string) => (/^R/i.test(state) ? 'idle' : /^(PD|P)/i.test(state) ? 'busy' : /^(F|NF|TO|CA|OOM|BF|DL)/i.test(state) ? 'error' : 'muted');

/** Elapsed against the job's wall-time limit, as a fraction (Slurm formats: d-hh:mm:ss). */
function slurmSeconds(t?: string): number | null {
  if (!t || /^(UNLIMITED|N\/A|INVALID)/i.test(t)) return null;
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return (+(d || 0) * 86400) + (+(h || 0) * 3600) + (+mm * 60) + +ss;
}

/**
 * One resource line of a partition tile. Three numbers that are not the same thing: `total` is what the
 * partition owns, `alloc` what jobs hold, `avail` what a job could get *now* — the gap between them is
 * capacity on down / drained / reserved nodes, drawn as the dim second segment of the bar.
 */
function Meter({ k, cls, total, alloc, avail, fmt = String }: { k: string; cls?: string; total?: number | null; alloc?: number | null; avail?: number | null; fmt?: (n: number) => string }) {
  if (total == null) {
    return <div className="part-meter"><span className="k">{k}</span><span className="bar split" /><span className="v">–</span></div>;
  }
  const a = alloc ?? 0;
  const av = avail ?? Math.max(0, total - a);
  const off = Math.max(0, total - a - av);
  const allocPct = total ? Math.min(100, (100 * a) / total) : 0;
  const offPct = total ? Math.min(100 - allocPct, (100 * off) / total) : 0;
  const busy = total ? (100 * (total - av)) / total : 0;
  const title = `${k.toUpperCase()}: ${fmt(av)} available of ${fmt(total)} — ${fmt(a)} allocated to jobs${off ? `, ${fmt(off)} on down / drained / reserved nodes` : ''}`;
  return (
    <div className="part-meter" title={title}>
      <span className="k">{k}</span>
      <span className={classNames('bar split', cls, busy > 90 ? 'crit' : busy > 75 ? 'warn' : '')}><i style={{ width: `${allocPct}%` }} /><i className="off" style={{ width: `${offPct}%` }} /></span>
      <span className="v">{fmt(av)} avail</span>
    </div>
  );
}

export function PartitionTile({ p }: { p: ClusterPartition }) {
  const idle = p.states.idle || 0;
  const unavailable = p.nodes_avail != null ? Math.max(0, p.nodes - p.nodes_avail) : 0;
  const detail = Object.keys(p.states).map((k) => `${p.states[k]} ${k}`).join(' · ');
  return (
    <div className="gauge">
      <div className="label">
        <span title={p.default ? 'default partition' : ''}><Icon name="server" size={12} /> {p.name}{p.default ? '*' : ''}</span>
        <span>{p.avail === 'up' ? (p.limit || '') : p.avail}</span>
      </div>
      <div className="value" title={unavailable ? `${unavailable} of ${p.nodes} nodes are down / drained / reserved` : ''}>{idle}<small>of {p.nodes} nodes idle</small></div>
      <Meter k="cpu" total={p.cpus?.total} alloc={p.cpus?.alloc} avail={p.cpus?.idle} />
      {p.gpus && p.gpus.total > 0 && <Meter k="gpu" cls="gpu" total={p.gpus.total} alloc={p.gpus.alloc} avail={p.gpus.idle} />}
      {p.mem && p.mem.total > 0 && <Meter k="mem" cls="mem" total={p.mem.total} alloc={p.mem.alloc} avail={p.mem.avail} fmt={compactBytes} />}
      <div className="sub" title={`${detail}${p.gres ? ` · ${p.gres}` : ''}`}>{detail}{p.gres ? ` · ${p.gres}` : ''}</div>
    </div>
  );
}

export function ClusterView({ machine: m }: { machine: MachineState }) {
  const { select, openModal } = useContext(AppCtx);
  const connected = m.status === 'connected';
  const kind = m.hello?.cluster?.kind;
  const { status, error, busy, reload } = useCluster(m.config.id, connected && !!kind);
  const [detail, setDetail] = useState<ClusterJobDetail | null>(null);
  const s = status?.summary;
  const jobs = status?.jobs || [];

  /** open a terminal that lives inside the job's allocation */
  const shell = async (jobId: string, workdir?: string | null) => {
    const spec = { type: 'custom', name: `job ${jobId} shell`, cwd: workdir || m.hello?.home || '~', workspace: workdir || m.hello?.home || '~',
      command: `srun --jobid=${shq(jobId)} --overlap --pty bash -l`, cols: 120, rows: 32 };
    const r = await api.act('open job shell', () => api.rpc<SessionInfo>(m.config.id, 'session.create', { spec }));
    if (r) select({ machineId: m.config.id, sessionId: r.id });
  };
  const tail = async (jobId: string) => {
    const d = await api.act('read job', () => api.rpc<ClusterJobDetail>(m.config.id, 'cluster.job', { job: jobId }));
    if (!d) return;
    if (!d.stdout) { api.toast('warn', `job ${jobId} has no StdOut path`); return; }
    const spec = { type: 'custom', name: `job ${jobId} output`, cwd: d.workdir || m.hello?.home || '~', workspace: d.workdir || m.hello?.home || '~',
      command: `tail -n 200 -F ${shq(d.stdout)}`, cols: 120, rows: 32 };
    const r = await api.act('tail job output', () => api.rpc<SessionInfo>(m.config.id, 'session.create', { spec }));
    if (r) select({ machineId: m.config.id, sessionId: r.id });
  };
  const cancel = (jobId: string) => openModal({
    type: 'confirm', title: `Cancel job ${jobId}`, text: `scancel ${jobId} on ${m.config.name}. Anything the job is running stops.`, danger: true,
    onOk: () => api.act('scancel', () => api.rpc(m.config.id, 'cluster.cancel', { job: jobId })).then(() => setTimeout(reload, 800)),
  });

  return (
    <>
      <div className="topbar">
        <div className="crumb"><a onClick={() => select({ machineId: m.config.id })}>{m.config.name}</a> /</div>
        <h1><span className={classNames('dot', connected ? 'connected' : m.status)} /> Cluster<span className="sub">{kind || 'no scheduler'}{m.hello?.hostname ? ` · ${m.hello.hostname}` : ''}</span></h1>
        <div className="spacer" />
        <button className="btn" disabled={!connected || busy} onClick={reload}><Icon name="refresh" size={14} /> Refresh</button>
        <button className="btn primary" disabled={!connected} onClick={() => openModal({ type: 'newAgent', machineId: m.config.id })}><Icon name="plus" size={14} /> New Agent</button>
      </div>
      <div className="content">
        {!kind ? <div className="empty">No scheduler on this machine.</div> : (
          <>
            {(error || status?.error) && <div className="banner warn"><Icon name="alert" size={15} /><div>{error || status?.error}</div></div>}
            {status?.unsupported && <div className="banner warn"><Icon name="alert" size={15} /><div>{kind} is installed here, but Hostler only reads Slurm queues so far.</div></div>}

            {s && (
              <div className="stats" style={{ marginBottom: 14 }} title="cluster-wide, every node counted once">
                <span className="stat" title={s.nodes.avail != null ? `${s.nodes.avail} of ${s.nodes.total} nodes usable (${s.nodes.total - s.nodes.avail} down / drained / reserved)` : ''}><Icon name="server" size={12} /><b>{s.nodes.idle}</b> of {s.nodes.total} nodes idle</span>
                {s.cpus && s.cpus.total > 0 && <span className="stat" title={`${s.cpus.alloc} allocated · ${s.cpus.other} unusable`}><Icon name="cpu" size={12} /><b>{s.cpus.idle}</b> of {s.cpus.total} CPUs available</span>}
                {s.gpus.total > 0 && <span className="stat" title={`${s.gpus.alloc} allocated`}><Icon name="gpu" size={12} /><b>{s.gpus.idle ?? Math.max(0, s.gpus.total - s.gpus.alloc)}</b> of {s.gpus.total} GPUs available</span>}
                {s.mem && s.mem.total > 0 && <span className="stat" title={`${fmtBytes(s.mem.alloc, 0)} allocated`}><Icon name="memory" size={12} /><b>{fmtBytes(s.mem.avail, 0)}</b> of {fmtBytes(s.mem.total, 0)} memory available</span>}
                <span className="stat"><Icon name="activity" size={12} /><b>{s.queue.running}</b> jobs running cluster-wide</span>
                <span className="stat"><Icon name="clock" size={12} /><b>{s.queue.pending}</b> queued</span>
                <span className="stat"><Icon name="bot" size={12} /><b>{s.mine.running}</b> yours running{s.mine.pending ? ` · ${s.mine.pending} pending` : ''}</span>
              </div>
            )}

            <div className="card" style={{ marginBottom: 14 }}>
              <h3><Icon name="layers" size={13} /> Partitions <span className="sub">{status?.partitions.length || 0}</span></h3>
              {status ? <div className="gauges">{status.partitions.map((p) => <PartitionTile key={p.name} p={p} />)}</div> : <div className="empty small">reading queues…</div>}
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <h3><Icon name="list" size={13} /> Your jobs <span className="sub">{jobs.length ? `${jobs.length} in the queue` : 'nothing queued'}</span></h3>
              {jobs.length === 0 ? <div className="empty small">No jobs of yours in the queue.</div> : (
                <div className="tbl-wrap"><table className="tbl">
                  <thead><tr><th>Job</th><th>Partition</th><th>State</th><th className="num">Nodes · CPU · GPU</th><th>Time</th><th>Where / why</th><th></th></tr></thead>
                  <tbody>
                    {jobs.map((j) => {
                      const used = slurmSeconds(j.time);
                      const cap = slurmSeconds(j.limit);
                      const frac = used != null && cap ? Math.min(100, (100 * used) / cap) : 0;
                      const running = /^R/i.test(j.state);
                      return (
                        <tr key={j.id}>
                          <td><span className="name-cell"><span style={{ minWidth: 0 }}><span className="t">{j.name}</span><span className="s mono">{j.id}</span></span></span></td>
                          <td className="nowrap">{j.partition}</td>
                          <td className="nowrap"><span className={classNames('badge', jobTone(j.state))}>{j.state.toLowerCase()}</span></td>
                          <td className="num nowrap">{j.nodes}{j.cpus ? ` · ${j.cpus}c` : ''}{j.gpus ? ` · ${j.gpus}g` : ''}</td>
                          <td className="nowrap" style={{ minWidth: 140 }}>
                            <div className="mono small">{j.time}{j.limit ? ` / ${j.limit}` : ''}</div>
                            {cap ? <div className={classNames('bar', frac > 90 ? 'crit' : frac > 75 ? 'warn' : '')} style={{ marginTop: 3 }}><i style={{ width: `${frac}%` }} /></div> : null}
                          </td>
                          <td className="mono trunc" style={{ maxWidth: 220 }} title={j.reason}>{j.reason}</td>
                          <td className="actions">
                            <span className="row-actions">
                              {running && <button className="btn sm ghost icon" title="Open a shell inside this job (srun --overlap --pty)" onClick={() => shell(j.id, undefined)}><Icon name="terminal" size={13} /></button>}
                              {running && <button className="btn sm ghost icon" title="Follow the job's output" onClick={() => tail(j.id)}><Icon name="log" size={13} /></button>}
                              <button className="btn sm ghost icon" title="Job details (scontrol)" onClick={() => api.rpc<ClusterJobDetail>(m.config.id, 'cluster.job', { job: j.id }).then(setDetail).catch((e) => api.toast('error', e.message))}><Icon name="search" size={13} /></button>
                              <button className="btn sm ghost icon danger" title="Cancel this job (scancel)" onClick={() => cancel(j.id)}><Icon name="x" size={13} /></button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              )}
            </div>

            {(status?.recent?.length || 0) > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <h3><Icon name="history" size={13} /> Finished today <span className="sub">sacct</span></h3>
                <div className="tbl-wrap"><table className="tbl">
                  <thead><tr><th>Job</th><th>Partition</th><th>State</th><th>Elapsed</th><th>Exit</th><th>Ended</th></tr></thead>
                  <tbody>
                    {status!.recent!.map((r) => (
                      <tr key={r.id}>
                        <td><span className="name-cell"><span style={{ minWidth: 0 }}><span className="t">{r.name}</span><span className="s mono">{r.id}</span></span></span></td>
                        <td className="nowrap">{r.partition}</td>
                        <td className="nowrap"><span className={classNames('badge', jobTone(r.state))}>{r.state.toLowerCase()}</span></td>
                        <td className="nowrap mono">{r.elapsed}</td>
                        <td className="nowrap mono">{r.exit}</td>
                        <td className="nowrap muted small">{r.end.replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            )}

            {detail && (
              <div className="card" style={{ marginBottom: 14 }}>
                <h3><Icon name="search" size={13} /> Job {detail.id} <span className="sub">{detail.state || ''}</span><span className="spacer" />
                  <button className="btn sm ghost" onClick={() => setDetail(null)}>close</button>
                </h3>
                <div className="log-box" style={{ maxHeight: 260 }}>{detail.raw || '(no output)'}</div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
