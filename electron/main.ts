import { app, BrowserWindow, shell, Menu, safeStorage } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, type ServerHandle } from '../server/server';

let server: ServerHandle | null = null;
let win: BrowserWindow | null = null;

// keep Electron's own profile data (caches, cookies…) out of the Hostler config dir
app.setPath('userData', path.join(app.getPath('appData'), 'hostler', 'electron'));

/**
 * Secrets at rest go through the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret or kwallet).
 * On Linux without a keyring Electron falls back to "basic_text", which is obfuscation rather than encryption —
 * in that case remembering passwords is disabled entirely (they stay in memory for the session).
 */
function secretCodec() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const backendName = typeof (safeStorage as any).getSelectedStorageBackend === 'function' ? (safeStorage as any).getSelectedStorageBackend() : 'os';
  if (backendName === 'basic_text' || backendName === 'unknown') return null;
  return {
    backend: 'keychain' as const,
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (enc: string) => safeStorage.decryptString(Buffer.from(enc, 'base64')),
  };
}

/**
 * Open a link in the user's own browser.
 *
 * Electron's shell.openExternal goes through GTK, and on GNOME that path can fail silently when
 * the call has a parent window — it only leaves "GLib-GObject: instance has no handler" warnings
 * behind, and no browser appears. So on Linux hand the URL to xdg-open, the same mechanism every
 * other desktop app uses, and fall back through gio to openExternal.
 */
function openExternalUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return;      // never hand about:blank / file: / javascript: to the desktop
  const attempts: [string, string[]][] = [];
  if (process.platform === 'linux') {
    if (process.env.BROWSER) attempts.push([process.env.BROWSER, [url]]);
    attempts.push(['xdg-open', [url]], ['gio', ['open', url]]);
  }
  const run = (i: number) => {
    if (i >= attempts.length) {
      shell.openExternal(url).catch((e) => console.error(`[hostler] could not open ${url}: ${e.message}`));
      return;
    }
    const [cmd, args] = attempts[i];
    let settled = false;
    const fail = () => { if (!settled) { settled = true; run(i + 1); } };
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      p.once('error', fail);
      p.once('exit', (code) => { if (code) fail(); else settled = true; });
      p.unref();
    } catch { fail(); }
  };
  run(0);
}

async function createWindow() {
  const devUrl = process.env.HOSTLER_DEV_URL;
  server = await startServer({ port: devUrl ? 7788 : 0, secretCodec: secretCodec() });
  const url = devUrl ? `${devUrl}/?token=${server.token}` : server.url;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: 'Hostler', backgroundColor: '#0f1115', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // links from the terminal open in the real browser — never as another Electron window
  win.webContents.setWindowOpenHandler(({ url: u }) => { openExternalUrl(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => {
    try { if (new URL(u).origin === new URL(win!.webContents.getURL()).origin) return; } catch { /* not a URL we know */ }
    e.preventDefault();
    openExternalUrl(u);
  });
  await win.loadURL(url);
  win.on('closed', () => (win = null));
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Hostler', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
]));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', () => { server?.close(); });
