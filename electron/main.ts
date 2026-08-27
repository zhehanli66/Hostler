import { app, BrowserWindow, shell, Menu, safeStorage } from 'electron';
import path from 'node:path';
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

async function createWindow() {
  const devUrl = process.env.HOSTLER_DEV_URL;
  server = await startServer({ port: devUrl ? 7788 : 0, secretCodec: secretCodec() });
  const url = devUrl ? `${devUrl}/?token=${server.token}` : server.url;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: 'Hostler', backgroundColor: '#0f1115', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
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
