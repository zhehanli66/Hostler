import { contextBridge } from 'electron';
contextBridge.exposeInMainWorld('hostler', { platform: process.platform, electron: true });
