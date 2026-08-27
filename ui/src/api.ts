import { useSyncExternalStore } from 'react';
import type { AppState } from '@shared/types';

type Listener = () => void;
type Handler = (msg: any) => void;

function getToken(): string {
  const q = new URLSearchParams(location.search).get('token');
  if (q) { try { localStorage.setItem('hostler_token', q); } catch { /* ignore */ } return q; }
  try { return localStorage.getItem('hostler_token') || ''; } catch { return ''; }
}

export class Api {
  state: AppState = { version: '', machines: [], workspaces: [], capabilities: { secretStorage: 'none', desktop: false } };
  connected = false;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private handlers = new Map<string, Set<Handler>>();
  private retry = 1000;
  toasts: { id: number; level: string; text: string }[] = [];
  constructor() { this.connect(); }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 1000; this.notify(); };
    ws.onclose = () => {
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('disconnected'));
      this.pending.clear();
      this.notify();
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'error'));
        return;
      }
      if (msg.ev === 'state') {
        this.state = { version: msg.version, machines: msg.machines, workspaces: msg.workspaces, capabilities: msg.capabilities || { secretStorage: 'none', desktop: false } };
        this.notify();
      } else if (msg.ev === 'toast') {
        this.toast(msg.level, msg.text);
      }
      if (msg.ev) for (const h of this.handlers.get(msg.ev) || []) h(msg);
    };
  }

  private notify() { for (const l of this.listeners) l(); }
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.state;

  on(ev: string, h: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(h);
    return () => { this.handlers.get(ev)?.delete(h); };
  }

  call<T = any>(op: string, params: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected to control plane'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...params, id, op }));
    });
  }

  rpc<T = any>(machineId: string, rop: string, params: Record<string, any> = {}): Promise<T> {
    return this.call<T>('rpc', { machineId, rop, params });
  }

  toast(level: string, text: string) {
    const id = Date.now() + Math.random();
    this.toasts = [...this.toasts, { id, level, text }];
    this.notify();
    setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); this.notify(); }, level === 'error' ? 8000 : 4000);
  }

  /** run an action, toast on failure */
  async act<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try { return await fn(); } catch (e: any) { this.toast('error', `${label}: ${e.message}`); return undefined; }
  }
}

export const api = new Api();

export function useAppState(): AppState {
  return useSyncExternalStore(api.subscribe, api.getSnapshot);
}

export function useApiMeta() {
  return useSyncExternalStore(api.subscribe, () => `${api.connected}|${api.toasts.length}`);
}

export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const b64ToText = (b64: string) => new TextDecoder().decode(b64ToBytes(b64));
export function textToB64(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
