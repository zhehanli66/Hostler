import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatResult, ChatToolCall, MachineState, SessionInfo } from '@shared/types';
import { api, textToB64 } from '../api';
import { activitySummary, agoIso, classNames, TYPE_LABEL } from '../util';
import { Icon, TypeAvatar } from './icons';

/**
 * The conversation, read out of the agent's own transcript, with a composer at the bottom.
 *
 * Input still goes to the real CLI over the PTY — this is a nicer face on the same session,
 * not a reimplementation of it, so the Terminal tab stays the place to answer a permission
 * prompt or drive the TUI directly.
 */
export function ChatView({ machineId, session: s }: { machineId: string; session: SessionInfo }) {
  const [res, setRes] = useState<ChatResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const live = s.status === 'running' || s.status === 'adopted';
  const beat = s.activity?.last_ts || '';

  const load = useCallback(async () => {
    try {
      const r = await api.rpc<ChatResult>(machineId, 'chat.messages', { session: s.id, limit: 300 });
      setRes(r);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [machineId, s.id]);

  useEffect(() => { load(); }, [load, beat]);
  useEffect(() => {
    const t = setInterval(load, live ? 2000 : 10000);
    return () => clearInterval(t);
  }, [load, live]);

  // keep the view pinned to the newest message, unless the reader has scrolled up to look back
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [res]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async (text: string) => {
    if (!text.trim()) return;
    setDraft('');
    // a multi-line prompt has to arrive as a paste, or the CLI submits at the first newline
    const data = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    await api.act('send', async () => {
      await api.rpc(machineId, 'session.input', { session: s.id, data: textToB64(data) });
      await new Promise((r) => setTimeout(r, 40));
      await api.rpc(machineId, 'session.input', { session: s.id, data: textToB64('\r') });
    });
    pinned.current = true;
    setTimeout(load, 600);
  };
  const key = (text: string) => api.rpc(machineId, 'session.input', { session: s.id, data: textToB64(text) }).catch((e) => api.toast('error', e.message));

  const msgs = res?.messages || [];
  const sum = activitySummary(s.activity);
  const working = live && (s.activity?.status === 'tool' || s.activity?.status === 'thinking' || s.activity?.status === 'subagents');

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {err && <div className="banner error"><Icon name="alert" size={15} /><span>{err}</span></div>}
        {!res && !err && <div className="empty"><Icon name="layers" size={22} /><div>reading the transcript…</div></div>}
        {res && !msgs.length && (
          <div className="empty">
            <Icon name="bot" size={22} />
            <div>{res.error || `Nothing in this ${TYPE_LABEL[res.kind] || res.kind} conversation yet — say something below.`}</div>
          </div>
        )}
        <div className="chat-list">
          {msgs.map((m) => <Bubble key={m.id} m={m} kind={res!.kind} />)}
          {working && (
            <div className="chat-msg assistant">
              <TypeAvatar type={s.type} size={26} />
              <div className="chat-body"><div className="chat-working"><span className="dot busy" /> {sum.label}{sum.detail ? ` — ${sum.detail}` : ''}</div></div>
            </div>
          )}
        </div>
      </div>
      <Composer value={draft} onChange={setDraft} onSend={send} onKey={key} disabled={!s.has_pty} live={live} />
    </div>
  );
}

function Bubble({ m, kind }: { m: ChatMessage; kind: string }) {
  const [openThinking, setOpenThinking] = useState(false);
  const empty = !m.text.trim() && !m.thinking.trim() && !m.tools.length;
  if (empty) return null;
  return (
    <div className={classNames('chat-msg', m.role)}>
      {m.role === 'assistant' ? <TypeAvatar type={kind} size={26} /> : <span className="chat-you" title="you">you</span>}
      <div className="chat-body">
        {m.thinking.trim() && (
          <div className="chat-thinking">
            <button className="chat-thinking-head" onClick={() => setOpenThinking(!openThinking)}>
              <Icon name={openThinking ? 'chevronDown' : 'chevronRight'} size={12} /> thought for a moment
            </button>
            {openThinking && <Markdown text={m.thinking} />}
          </div>
        )}
        {m.text.trim() && <div className="chat-text"><Markdown text={m.text} /></div>}
        {m.tools.map((t, i) => <ToolRow key={t.id || i} t={t} />)}
        <div className="chat-meta">
          {m.ts && <span>{agoIso(m.ts)}</span>}
          {m.model && <span className="mono">{m.model}</span>}
          {m.usage?.output ? <span>{fmtK(m.usage.output)} out</span> : null}
        </div>
      </div>
    </div>
  );
}

function ToolRow({ t }: { t: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={classNames('chat-tool', t.status)}>
      <button className="chat-tool-head" onClick={() => t.output && setOpen(!open)} disabled={!t.output}>
        <span className={classNames('dot', t.status === 'running' ? 'busy' : t.status === 'error' ? 'error' : 'idle')} />
        <b>{t.name}</b>
        <span className="chat-tool-sum">{t.summary || ''}</span>
        {t.output && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
      </button>
      {open && t.output && <pre className="chat-tool-out">{t.output}</pre>}
    </div>
  );
}

function Composer({ value, onChange, onSend, onKey, disabled, live }: {
  value: string; onChange: (v: string) => void; onSend: (v: string) => void;
  onKey: (s: string) => void; disabled?: boolean; live: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, el.scrollHeight) + 'px';
  }, [value]);
  return (
    <div className="composer">
      <div className={classNames('composer-box', disabled && 'off')}>
        <textarea
          ref={ta} rows={1} value={value} disabled={disabled}
          placeholder={disabled ? 'this session has no terminal attached — nothing to type into' : live ? 'Message the agent…  (Enter to send, Shift+Enter for a new line)' : 'the agent is not running'}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(value); } }}
        />
        <div className="composer-actions">
          <button className="btn sm ghost" title="Escape — interrupt what the agent is doing" onClick={() => onKey('\x1b')} disabled={disabled}>esc</button>
          <button className="btn sm ghost" title="Ctrl+C" onClick={() => onKey('\x03')} disabled={disabled}>^C</button>
          <button className="btn sm primary" onClick={() => onSend(value)} disabled={disabled || !value.trim()}><Icon name="send" size={13} /> Send</button>
        </div>
      </div>
      <div className="composer-hint">goes straight to the CLI over the PTY — switch to Terminal for permission prompts and anything the TUI draws</div>
    </div>
  );
}

/**
 * Just enough markdown for agent output: fenced code, inline code, bold and bare links.
 * Anything else is left as written, which is what a terminal would have shown anyway.
 */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: { code: boolean; lang?: string; text: string }[] = [];
    const re = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
    let at = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
      out.push({ code: true, lang: m[1] || undefined, text: m[2].replace(/\n$/, '') });
      at = re.lastIndex;
    }
    if (at < text.length) out.push({ code: false, text: text.slice(at) });
    return out.filter((b) => b.code || b.text.trim());
  }, [text]);
  return (
    <>
      {blocks.map((b, i) => b.code
        ? <pre key={i} className="chat-code">{b.lang && <span className="lang">{b.lang}</span>}<code>{b.text}</code></pre>
        : <Prose key={i} text={b.text.replace(/^\n+|\n+$/g, '')} />)}
    </>
  );
}

/** Headings, bullets and numbered items get structure; every other line stays as written. */
function Prose({ text }: { text: string }) {
  return (
    <div className="chat-prose">
      {text.split('\n').map((line, i) => {
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (h) return <div key={i} className={`chat-h h${h[1].length}`}>{inlineMd(h[2])}</div>;
        const li = /^(\s*)(?:[-*]|(\d+\.))\s+(.*)$/.exec(line);
        if (li) return (
          <div key={i} className="chat-li" style={li[1] ? { paddingLeft: 14 + li[1].length * 4 } : undefined}>
            <span className="chat-bullet">{li[2] || '•'}</span><span>{inlineMd(li[3])}</span>
          </div>
        );
        return <div key={i} className="chat-line">{inlineMd(line)}</div>;
      })}
    </div>
  );
}

function inlineMd(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<>]+)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<b key={k++}>{m[2]}</b>);
    else if (m[3] !== undefined) out.push(<Ref key={k++} label={m[3]} href={m[4]} />);
    else out.push(<a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
    at = re.lastIndex;
  }
  if (at < text.length) out.push(text.slice(at));
  return out.length ? out : [text];
}

/** A markdown link: only http(s) is clickable — agents mostly write local file paths. */
function Ref({ label, href }: { label: string; href: string }) {
  return /^https?:\/\//.test(href)
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={href}>{label}</a>
    : <code title={href}>{label}</code>;
}

function fmtK(n?: number | null) {
  if (!n) return '0';
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
