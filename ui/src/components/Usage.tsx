import React, { useContext, useEffect, useMemo, useState } from 'react';
import type { AppState, UsageReport } from '@shared/types';
import { BUILTIN_PRICES, PRICES_CHECKED, priceFor, type ModelPrice } from '@shared/pricing';
import { AppCtx } from '../App';
import { api } from '../api';
import { classNames, shortPath, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';
import {
  fmtTokens, fmtUsd, loadPrices, rollup, rowTokens, savePrices,
  type Bucket, type Period, type Row, type UsageSource,
} from '../usage';

const PERIODS: { k: Period; label: string }[] = [
  { k: 'today', label: 'Today' }, { k: 'week', label: 'This week' }, { k: 'month', label: 'This month' }, { k: 'all', label: 'All' },
];
const BUCKETS: Bucket[] = ['day', 'week', 'month'];
const KINDS = ['claude', 'codex', 'opencode'];
const SCAN_DAYS = 120;

type Fetched = { report?: UsageReport; error?: string; at: number };

/** Every connected machine's token spend, rolled up into days, weeks and months. */
export function UsageView({ state }: { state: AppState }) {
  const { select } = useContext(AppCtx);
  const [data, setData] = useState<Record<string, Fetched>>({});
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<Period>('month');
  const [bucket, setBucket] = useState<Bucket>('day');
  const [kinds, setKinds] = useState<string[]>([]);
  const [only, setOnly] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, ModelPrice>>(loadPrices);
  const [editPrices, setEditPrices] = useState(false);

  const connected = state.machines.filter((m) => m.status === 'connected');
  const ids = connected.map((m) => m.config.id).join(',');

  const refresh = React.useCallback(async (force: boolean) => {
    setLoading(true);
    const out: Record<string, Fetched> = {};
    await Promise.all(connected.map(async (m) => {
      try {
        out[m.config.id] = { report: await api.rpc<UsageReport>(m.config.id, 'usage.report', { days: SCAN_DAYS, force }), at: Date.now() };
      } catch (e: any) {
        out[m.config.id] = { error: e.message, at: Date.now() };
      }
    }));
    setData(out);
    setLoading(false);
  }, [ids]);

  useEffect(() => { refresh(false); }, [refresh]);

  // keyed on `ids`, not `connected` — that array is rebuilt on every state broadcast
  const sources: UsageSource[] = useMemo(() => connected
    .filter((m) => data[m.config.id]?.report && (!only.length || only.includes(m.config.id)))
    .map((m) => ({ machineId: m.config.id, machineName: m.config.name, report: data[m.config.id].report! })), [ids, data, only]);

  const r = useMemo(() => rollup(sources, { bucket, period, kinds, prices }), [sources, bucket, period, kinds, prices]);
  const failed = connected.filter((m) => data[m.config.id]?.error);
  const scanned = sources.reduce((a, s) => a + s.report.files, 0);
  const skipped = sources.reduce((a, s) => a + (s.report.truncated || 0), 0);
  const days = Math.max(1, new Set(r.slices.map((s) => s.key)).size);

  return (
    <>
      <div className="topbar">
        <h1><Icon name="zap" size={17} /> Usage <span className="sub">{sources.length} machine{sources.length === 1 ? '' : 's'} · {scanned} transcripts</span></h1>
        <div className="spacer" />
        <div className="seg">
          {PERIODS.map((p) => <button key={p.k} className={classNames('seg-btn', period === p.k && 'active')} onClick={() => setPeriod(p.k)}>{p.label}</button>)}
        </div>
        <button className="btn ghost sm icon" title="Model prices" onClick={() => setEditPrices(true)}><Icon name="settings" size={14} /></button>
        <button className="btn" onClick={() => refresh(true)} disabled={loading}><Icon name="refresh" size={14} /> {loading ? 'Scanning…' : 'Rescan'}</button>
      </div>

      <div className="content">
        {!connected.length && <div className="empty"><Icon name="server" size={22} /><div>No machine is connected — connect one to read its transcripts.</div></div>}
        {failed.map((m) => (
          <div key={m.config.id} className="banner warn"><Icon name="alert" size={15} />
            <span><b>{m.config.name}</b> could not be read: {data[m.config.id].error}. An older helper has no <span className="mono">usage.report</span> — reconnect the machine to upgrade it.</span>
          </div>
        ))}

        <div className="gauges" style={{ marginBottom: 14 }}>
          <Stat label="Cost" value={fmtUsd(r.total.cost)} sub={r.total.unpriced ? `+ ${fmtTokens(r.total.unpriced)} unpriced tokens` : `${fmtUsd(r.total.cost / days)} / ${bucket}`} />
          <Stat label="Tokens" value={fmtTokens(rowTokens(r.total))} sub={`${fmtTokens(r.total.input)} in · ${fmtTokens(r.total.output)} out`} />
          <Stat label="Cache" value={fmtTokens(r.total.cacheRead)} sub={`read · ${fmtTokens(r.total.cacheWrite)} written`} />
          <Stat label="Requests" value={r.total.messages.toLocaleString()} sub={`across ${r.sessions.length} conversation${r.sessions.length === 1 ? '' : 's'}`} />
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <h3>
            <Icon name="activity" size={13} /> Spend by {bucket}
            <span className="spacer" />
            <span className="sub">peak {fmtUsd(Math.max(0, ...r.slices.map((s) => s.cost)))}</span>
            <div className="seg sm">{BUCKETS.map((b) => <button key={b} className={classNames('seg-btn', bucket === b && 'active')} onClick={() => setBucket(b)}>{b}</button>)}</div>
          </h3>
          <Bars rows={r.slices} />
        </div>

        <div className="row-flex" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <span className="muted small">agents:</span>
          {KINDS.map((k) => (
            <button key={k} className={classNames('chip', (!kinds.length || kinds.includes(k)) && 'active')}
              onClick={() => setKinds((cur) => cur.includes(k) ? cur.filter((x) => x !== k) : [...(cur.length ? cur : []), k])}>{TYPE_LABEL[k] || k}</button>
          ))}
          {kinds.length > 0 && <button className="chip" onClick={() => setKinds([])}>all</button>}
          {connected.length > 1 && <>
            <span className="muted small" style={{ marginLeft: 10 }}>machines:</span>
            {connected.map((m) => (
              <button key={m.config.id} className={classNames('chip', (!only.length || only.includes(m.config.id)) && 'active')}
                onClick={() => setOnly((cur) => cur.includes(m.config.id) ? cur.filter((x) => x !== m.config.id) : [...(cur.length ? cur : []), m.config.id])}>{m.config.name}</button>
            ))}
            {only.length > 0 && <button className="chip" onClick={() => setOnly([])}>all</button>}
          </>}
        </div>

        <div className="grid2" style={{ marginBottom: 14 }}>
          <div className="card">
            <h3><Icon name="bot" size={13} /> By model</h3>
            <Breakdown rows={r.byModel} total={r.total} prices={prices} onPrice={() => setEditPrices(true)} />
          </div>
          <div className="card">
            {r.byMachine.length > 1
              ? <><h3><Icon name="server" size={13} /> By machine</h3><Breakdown rows={r.byMachine} total={r.total} prices={prices} /></>
              : <><h3><Icon name="bot" size={13} /> By agent</h3><Breakdown rows={r.byKind.map((k) => ({ ...k, label: TYPE_LABEL[k.key] || k.key }))} total={r.total} prices={prices} /></>}
          </div>
        </div>

        <div className="card">
          <h3><Icon name="log" size={13} /> Conversations <span className="sub">· {r.sessions.length}, biggest first</span></h3>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Conversation</th><th>Machine</th><th className="num">In</th><th className="num">Out</th>
                <th className="num">Cache r/w</th><th className="num">Reqs</th><th className="num">Cost</th>
              </tr></thead>
              <tbody>
                {r.sessions.slice(0, 60).map((s) => (
                  <tr key={s.machineId + s.path} className="clickable" onClick={() => select({ machineId: s.machineId })}>
                    <td>
                      <div className="name-cell">
                        <TypeAvatar type={s.kind} size={24} />
                        <span>
                          <span className="t">{s.title || s.id.slice(0, 8)}</span>
                          <span className="s mono" title={s.cwd || ''}>{s.cwd ? shortPath(s.cwd) : s.path}</span>
                        </span>
                      </div>
                    </td>
                    <td className="mono">{s.machineName}</td>
                    <td className="num">{fmtTokens(s.input)}</td>
                    <td className="num">{fmtTokens(s.output)}</td>
                    <td className="num">{fmtTokens(s.cache_read)} / {fmtTokens(s.cache_write)}</td>
                    <td className="num">{s.messages}</td>
                    <td className="num">{s.cost == null ? <span className="muted">–</span> : fmtUsd(s.cost)}</td>
                  </tr>
                ))}
                {!r.sessions.length && <tr><td colSpan={7}><div className="empty small">Nothing in this period.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="muted small" style={{ marginTop: 12 }}>
          Read from each machine's own transcripts, up to {SCAN_DAYS} days back. Costs use Anthropic list prices
          checked {PRICES_CHECKED}; models with no price show tokens only.
          {skipped > 0 && <> <b>{skipped} older transcript{skipped === 1 ? '' : 's'} were left out</b> — more than a helper scans in one pass.</>}
        </div>
      </div>

      {editPrices && <PriceModal prices={prices} models={r.byModel.map((m) => m.key)} onClose={() => setEditPrices(false)}
        onSave={(p) => { setPrices(p); savePrices(p); setEditPrices(false); }} />}
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="gauge">
      <div className="label"><span>{label}</span></div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** A bar per bucket. Cost drives the height where it is known, tokens otherwise. */
function Bars({ rows }: { rows: Row[] }) {
  if (!rows.length) return <div className="empty small"><Icon name="activity" size={20} /><div>No usage in this period.</div></div>;
  const priced = rows.some((r) => r.cost > 0);
  const val = (r: Row) => (priced ? r.cost : rowTokens(r));
  const max = Math.max(...rows.map(val)) || 1;
  const show = rows.slice(-60);
  const every = Math.ceil(show.length / 14);          // enough ticks to read, few enough not to collide
  return (
    <div className="bars">
      {show.map((r, i) => (
        <div key={r.key} className="bar-col" title={`${r.label}\n${fmtUsd(r.cost)} · ${fmtTokens(rowTokens(r))} tokens · ${r.messages} requests`}>
          <div className="bar-v"><i style={{ height: `${Math.max(2, (val(r) / max) * 100)}%` }} /></div>
          <span className="bar-k">{(show.length - 1 - i) % every === 0 ? r.label : ''}</span>
        </div>
      ))}
    </div>
  );
}

function Breakdown({ rows, total, prices, onPrice }: { rows: Row[]; total: Row; prices: Record<string, ModelPrice>; onPrice?: () => void }) {
  const max = Math.max(...rows.map(rowTokens), 1);
  if (!rows.length) return <div className="empty small">Nothing yet.</div>;
  return (
    <div className="breakdown">
      {rows.map((r) => {
        const unpriced = onPrice && !priceFor(r.key, prices);
        return (
          <div key={r.key} className="bd-row">
            <div className="bd-head">
              <span className="bd-name mono" title={r.key}>{r.label}</span>
              <span className="bd-val">
                {unpriced ? <button className="btn ghost sm" onClick={onPrice} title="no price for this model — set one">set price</button>
                  : r.cost === 0 && r.unpriced > 0 ? <span className="muted">unpriced</span>
                  : <>{fmtUsd(r.cost)}{r.unpriced > 0 && <span className="muted" title={`${fmtTokens(r.unpriced)} tokens have no price`}> +</span>}</>}
              </span>
            </div>
            <div className="bar"><i style={{ width: `${(rowTokens(r) / max) * 100}%` }} /></div>
            <div className="bd-sub">{fmtTokens(rowTokens(r))} tokens · {r.messages} requests · {Math.round((rowTokens(r) / Math.max(1, rowTokens(total))) * 100)}%</div>
          </div>
        );
      })}
    </div>
  );
}

function PriceModal({ prices, models, onClose, onSave }: {
  prices: Record<string, ModelPrice>; models: string[]; onClose: () => void; onSave: (p: Record<string, ModelPrice>) => void;
}) {
  const rows = useMemo(() => {
    const all = new Set([...models, ...Object.keys(prices), ...Object.keys(BUILTIN_PRICES)]);
    return [...all].sort();
  }, [models, prices]);
  const [draft, setDraft] = useState<Record<string, ModelPrice>>(prices);
  const set = (model: string, field: 'input' | 'output', v: string) => {
    const n = parseFloat(v);
    const base = draft[model] || priceFor(model, draft) || { input: 0, output: 0 };
    setDraft({ ...draft, [model]: { ...base, [field]: isNaN(n) ? 0 : n } });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header><Icon name="settings" size={15} /> Model prices <span className="spacer" /><button className="btn ghost sm icon" onClick={onClose}><Icon name="x" size={14} /></button></header>
        <div className="body">
          <div className="muted small">
            USD per million tokens. Anthropic rates ship with Hostler (checked {PRICES_CHECKED}); anything else —
            Codex and OpenCode run on other providers — needs a price here before it can be costed. Cache reads bill at
            0.1× input, writes at 1.25× (5&nbsp;min) and 2× (1&nbsp;hour).
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Model</th><th className="num">Input $/1M</th><th className="num">Output $/1M</th><th /></tr></thead>
              <tbody>
                {rows.map((m) => {
                  const eff = draft[m] || BUILTIN_PRICES[m] || priceFor(m, draft);
                  const custom = !!draft[m];
                  return (
                    <tr key={m}>
                      <td className="mono">{m}</td>
                      <td className="num"><input className="price-in" value={eff?.input ?? ''} placeholder="–" onChange={(e) => set(m, 'input', e.target.value)} /></td>
                      <td className="num"><input className="price-in" value={eff?.output ?? ''} placeholder="–" onChange={(e) => set(m, 'output', e.target.value)} /></td>
                      <td className="actions">{custom && <button className="btn ghost sm" onClick={() => { const d = { ...draft }; delete d[m]; setDraft(d); }}>reset</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <footer>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(draft)}>Save</button>
        </footer>
      </div>
    </div>
  );
}
