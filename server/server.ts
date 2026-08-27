import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { MachineManager } from './machines';
import { loadOrCreateToken, setSecretCodec, type SecretCodec } from './config';
import { parseSshConfig } from './sshconfig';
import { DEFAULT_PORT } from '../shared/protocol';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

export interface ServerHandle { port: number; token: string; url: string; manager: MachineManager; close(): Promise<void> }

export async function startServer(opts: { port?: number; host?: string; uiDir?: string; token?: string; secretCodec?: SecretCodec | null } = {}): Promise<ServerHandle> {
  const host = opts.host || '127.0.0.1';
  const token = opts.token || (process.env.HOSTLER_NO_AUTH ? '' : loadOrCreateToken());
  setSecretCodec(opts.secretCodec ?? null);
  const manager = new MachineManager();
  const uiDir = opts.uiDir || findUiDir();

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, machines: manager.machines.size }));
      return;
    }
    if (!uiDir) {
      res.setHeader('content-type', 'text/plain');
      res.end('Hostler control plane is running. UI not built: run `npm run build:ui` (or use `npm run dev`).');
      return;
    }
    let p = path.normalize(decodeURIComponent(url.pathname));
    if (p === '/' || p === '\\') p = '/index.html';
    const file = path.join(uiDir, p);
    if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA fallback
      res.setHeader('content-type', 'text/html; charset=utf-8');
      fs.createReadStream(path.join(uiDir, 'index.html')).pipe(res);
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (token && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const clients = new Map<string, WebSocket>();
  const send = (ws: WebSocket, msg: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg: any) => { const s = JSON.stringify(msg); for (const ws of clients.values()) if (ws.readyState === WebSocket.OPEN) ws.send(s); };
  const stateMsg = () => ({ ev: 'state', ...manager.getState() });

  manager.on('change', () => broadcast(stateMsg()));
  manager.on('machine-removed', (id: string) => broadcast({ ev: 'machine.removed', id }));
  manager.on('output', (machineId: string, session: string, data: string) => {
    const conn = manager.machines.get(machineId);
    if (!conn) return;
    for (const [wsId, ws] of clients) if (conn.wants(session, wsId)) send(ws, { ev: 'output', machineId, session, data });
  });
  manager.on('session-event', (machineId: string, ev: any) => broadcast({ ...ev, machineId }));

  wss.on('connection', (ws) => {
    const wsId = crypto.randomBytes(6).toString('hex');
    clients.set(wsId, ws);
    send(ws, { ev: 'hello', version: manager.getState().version });
    send(ws, stateMsg());
    ws.on('message', async (raw) => {
      let req: any;
      try { req = JSON.parse(raw.toString()); } catch { return; }
      try {
        const result = await handle(wsId, req);
        send(ws, { id: req.id, ok: true, result });
      } catch (e: any) {
        send(ws, { id: req.id, ok: false, error: e?.message || String(e) });
      }
    });
    ws.on('close', () => {
      clients.delete(wsId);
      for (const c of manager.machines.values()) c.detach(wsId).catch(() => undefined);
    });
  });

  async function handle(wsId: string, req: any): Promise<any> {
    switch (req.op) {
      case 'state': return manager.getState();
      case 'ssh.hosts': return parseSshConfig();
      case 'machine.add': {
        const conn = manager.addMachine(req.config || {});
        if (req.connect !== false) conn.connect(req.config?.password).catch(() => undefined);
        return conn.state;
      }
      case 'machine.update': return manager.updateMachine(req.machineId, req.patch || {}).state;
      case 'machine.remove': manager.removeMachine(req.machineId); return true;
      case 'machine.connect': { const c = manager.get(req.machineId); c.connect(req.password, !!req.remember).catch(() => undefined); return true; }
      case 'machine.installKey': return manager.get(req.machineId).installKey();
      case 'machine.disconnect': manager.get(req.machineId).disconnect(); return true;
      case 'machine.log': return manager.get(req.machineId).logLines;
      case 'workspace.add': return manager.addWorkspace(req.machineId, req.path, req.name);
      case 'workspace.remove': manager.removeWorkspace(req.workspaceId); return true;
      case 'rpc': {
        const conn = manager.get(req.machineId);
        const { id: _i, op: _o, machineId: _m, rop, params, ...rest } = req;
        const p = { ...(params || {}), ...rest };
        if (rop === 'session.attach') return conn.attach(wsId, p.session, p.cols, p.rows);
        if (rop === 'session.detach') { await conn.detach(wsId, p.session); return true; }
        const result = await conn.rpc(rop, p, req.timeout);
        if (rop === 'session.create' || rop === 'adopt' || rop === 'session.remove' || rop === 'session.restart') {
          if (rop === 'session.create' && p.spec?.workspace) manager.addWorkspace(req.machineId, p.spec.workspace);
          setTimeout(() => manager.emit('change'), 50);
        }
        return result;
      }
      default: throw new Error('unknown op ' + req.op);
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? DEFAULT_PORT, host, () => resolve((httpServer.address() as any).port));
  });
  manager.autoConnect();
  const url = `http://${host}:${port}/${token ? `?token=${token}` : ''}`;
  return {
    port, token, url, manager,
    close: () => new Promise<void>((resolve) => { manager.shutdown(); wss.close(); httpServer.close(() => resolve()); }),
  };
}

function findUiDir(): string | undefined {
  const candidates = [path.join(__dirname, '..', 'ui'), path.join(__dirname, '..', '..', 'dist', 'ui'), path.join(process.cwd(), 'dist', 'ui')];
  if ((process as any).resourcesPath) candidates.unshift(path.join((process as any).resourcesPath, 'app', 'dist', 'ui'));
  // a built UI has an assets/ dir; the source ui/ dir (index.html pointing at /src) must not be served
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html')) && fs.existsSync(path.join(c, 'assets')));
}
