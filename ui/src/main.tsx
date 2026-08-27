import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
