// Standalone control plane (browser mode): node dist/server/index.js  or  npx tsx server/index.ts
import { startServer } from './server';
import { spawn } from 'node:child_process';

const port = parseInt(process.env.PORT || process.env.HOSTLER_PORT || '7788', 10);
startServer({ port }).then((srv) => {
  console.log(`Hostler control plane listening on ${srv.url}`);
  if (process.env.HOSTLER_DEV) console.log(`  dev UI: http://127.0.0.1:5173/?token=${srv.token}`);
  if (process.env.HOSTLER_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(opener, [srv.url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch { /* ignore */ }
    console.log('  (opened in your browser; Ctrl+C stops the control plane, agents on remote machines keep running)');
  }
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((e) => {
  console.error('failed to start:', e.message);
  process.exit(1);
});
