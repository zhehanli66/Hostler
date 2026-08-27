import React from 'react';

// Minimal stroke icon set (lucide-style paths), inlined to keep the app dependency-free.
const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  stop: 'M6 6h12v12H6z',
  restart: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  x: 'M18 6L6 18M6 6l12 12',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.4L3 16M3 21v-5h5',
  branch: 'M6 3v12M18 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9c0 6-12 3-12 9',
  cpu: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM9 9h6v6H9z',
  activity: 'M22 12h-4l-3 8-6-16-3 8H2',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  unlink: 'M18 6L6 18M8 5a4 4 0 0 1 7 3M16 19a4 4 0 0 1-7-3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  log: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h8',
  download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-4-4',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gpu: 'M2 7h20v10H2zM6 11h4v2H6zM14 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  memory: 'M4 8h16v8H4zM8 8v8M12 8v8M16 8v8M4 16v3M20 16v3',
  disk: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
  bot: 'M12 3v3M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3M9 12h.01M15 12h.01M9 16h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  play: 'M6 4l14 8-14 8z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  pin: 'M12 17v5M8 3h8l-1 7 3 3H6l3-3z',
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 15, className, style, strokeWidth = 1.8 }: { name: IconName; size?: number; className?: string; style?: React.CSSProperties; strokeWidth?: number }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/** Colored monogram avatar for an agent type */
export function TypeAvatar({ type, size = 26 }: { type: string; size?: number }) {
  const label = type === 'claude' ? 'CC' : type === 'codex' ? 'CX' : type === 'opencode' ? 'OC' : type === 'shell' ? '>_' : '⌘';
  return <span className={`avatar ${type}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>{label}</span>;
}

export function Sparkline({ values, max = 100, color = 'var(--accent)', width = 120, height = 26 }: { values: number[]; max?: number; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (Math.min(v, max) / max) * (height - 4)).toFixed(1)}`);
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  return (
    <svg width={width} height={height} className="spark" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      <path d={area} fill={color} opacity="0.12" />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
