import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

/** JSON-lines RPC client for the remote helper (over any duplex stream: unix socket, ssh channel). */
export class HelperClient extends EventEmitter {
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;

  constructor(public stream: Duplex) {
    super();
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => this.onData(chunk.toString()));
    const onClose = (err?: Error) => this.handleClose(err);
    stream.on('close', () => onClose());
    stream.on('end', () => onClose());
    stream.on('error', (e: Error) => onClose(e));
  }

  private onData(text: string) {
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'helper error'));
      } else if (msg.ev) {
        this.emit('event', msg);
        this.emit('ev:' + msg.ev, msg);
      }
    }
  }

  private handleClose(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err || new Error('helper connection closed'));
    }
    this.pending.clear();
    this.emit('close', err);
  }

  call<T = any>(op: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('helper connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper call ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.stream.write(JSON.stringify({ ...params, id, op }) + '\n');
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try { this.stream.end(); } catch { /* ignore */ }
    try { (this.stream as any).destroy?.(); } catch { /* ignore */ }
    this.handleClose();
  }
}
