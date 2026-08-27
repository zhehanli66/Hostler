// Demo mode (HOSTLER_DEMO=1): synthetic machines/agents so the UI can be explored (and screenshotted) without any SSH host.
import type { MachineState, SessionInfo, WorkspaceConfig } from '../shared/types';

const now = () => Date.now() / 1000;
const iso = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString();

function session(p: Partial<SessionInfo> & { id: string; name: string; type: SessionInfo['type']; cwd: string }): SessionInfo {
  return {
    workspace: p.cwd, command: p.command ?? p.type, pid: p.pid ?? 4000, status: 'running', exit_code: null, exit_signal: null,
    created: now() - 3600, started: now() - 3600, ended: null, cols: 120, rows: 32, adopted: false, tmux_target: null, meta: {}, restarts: 0,
    last_output: now() - 3, error: null, has_pty: true, processes: [], scrollback_bytes: 20000, activity: null, ...p,
  };
}

export function demoMachines(): { machines: MachineState[]; workspaces: WorkspaceConfig[] } {
  const t = now();
  const gpu: MachineState = {
    config: { id: 'demo-gpu', name: 'gpu-box', transport: 'ssh', host: 'gpu-box.lab', user: 'dev', createdAt: 0, keyInstalled: true },
    status: 'connected', error: null, authMethod: 'publickey', hasPassword: false, connectedAt: Date.now() - 7200e3, lastUpdate: Date.now(),
    hello: { version: '0.1.4', protocol: 1, pid: 2211, hostname: 'gpu-box', user: 'dev', home: '/home/dev', shell: '/bin/zsh', os: 'Ubuntu 24.04 LTS', arch: 'x86_64', python: '3.12.3',
      tools: { claude: '/home/dev/.local/bin/claude', codex: '/home/dev/.local/bin/codex', opencode: null, tmux: '/usr/bin/tmux', git: '/usr/bin/git', 'nvidia-smi': '/usr/bin/nvidia-smi', python3: '/usr/bin/python3' },
      subreaper: true, gpu_kind: 'nvidia', sock: '/home/dev/.hostler/helper.sock', started: t - 7200 },
    resources: { cpu_pct: 37, cores: 32, load: [11.2, 9.8, 7.1], mem_total: 128e9, mem_used: 61e9, mem_available: 67e9, swap_total: 8e9, swap_used: 0.4e9,
      disk: { path: '/home/dev', total: 2e12, free: 0.9e12 }, uptime: 86400 * 12,
      gpus: [{ index: 0, name: 'NVIDIA RTX 6000 Ada', util: 91, mem_used: 38e9, mem_total: 48e9, temp: 71, power: 265 }, { index: 1, name: 'NVIDIA RTX 6000 Ada', util: 4, mem_used: 2e9, mem_total: 48e9, temp: 41, power: 30 }], gpu_kind: 'nvidia' },
    discovered: [{ pid: 8811, type: 'codex', cmd: 'codex --full-auto', args: '--full-auto', cwd: '/home/dev/scratch', started: t - 900, tty: '/dev/pts/7', tmux_target: 'main:2.0', cpu: 1.2, rss: 180e6, background: false, user: 'dev' }],
    sessions: [
      session({ id: 'd1', name: 'refactor data loader', type: 'claude', cwd: '/home/dev/src/vision-pipeline', command: 'claude --session-id 5e1c…', pid: 5101,
        processes: [
          { pid: 5101, ppid: 2211, name: 'node', state: 'S', cmd: 'claude --session-id 5e1c…', cpu: 12, rss: 420e6, started: t - 3600, detached: false, root: true },
          { pid: 5188, ppid: 5101, name: 'bash', state: 'S', cmd: 'bash -c pytest tests/loader -x', cpu: 0.4, rss: 8e6, started: t - 40, detached: false, root: false },
          { pid: 5190, ppid: 5188, name: 'python', state: 'R', cmd: 'python -m pytest tests/loader -x', cpu: 98, rss: 1.2e9, gpu_mem: 3.1e9, started: t - 39, detached: false, root: false },
        ],
        activity: { kind: 'claude', status: 'tool', current_tool: { id: 't', name: 'Bash', summary: 'pytest tests/loader -x', ts: iso(40) }, pending_tools: [{ name: 'Bash', summary: 'pytest tests/loader -x' }],
          last_text: 'The shuffling bug is in `Prefetcher.__iter__`; running the loader tests before touching the batching code.', last_prompt: 'Make the data loader deterministic under num_workers>0', last_ts: iso(40),
          model: 'claude-opus-5', usage: { input: 1200, output: 18400, cache_read: 412000 }, title: 'Deterministic data loader', turns: 6, tool_calls: 74, session_id: '5e1c0a9b-1', transcript: null, age: 40,
          subagents: [
            { id: 'a1', type: 'Explore', description: 'Trace seed handling across workers', started: iso(300), status: 'running', async: true,
              activity: { status: 'tool', current_tool: { name: 'Grep', summary: 'torch.manual_seed|worker_init_fn' }, pending_tools: [], last_text: null, last_prompt: null, last_ts: iso(5), model: 'claude-sonnet-5', usage: null, title: null, turns: 1, tool_calls: 23 } },
            { id: 'a2', type: 'general-purpose', description: 'Write regression test for shuffle order', started: iso(620), status: 'completed',
              activity: { status: 'idle', current_tool: null, pending_tools: [], last_text: 'Added tests/loader/test_shuffle_determinism.py (3 cases).', last_prompt: null, last_ts: iso(200), model: 'claude-sonnet-5', usage: null, title: null, turns: 1, tool_calls: 17 } },
          ] } }),
      session({ id: 'd2', name: 'train resnet-50 (seed 3)', type: 'custom', cwd: '/home/dev/src/vision-pipeline', command: 'python train.py --config cfg/r50.yaml --seed 3', pid: 6120, created: now() - 5 * 3600, started: now() - 5 * 3600,
        processes: [
          { pid: 6120, ppid: 2211, name: 'python', state: 'R', cmd: 'python train.py --config cfg/r50.yaml --seed 3', cpu: 310, rss: 9.4e9, gpu_mem: 34.9e9, started: t - 5 * 3600, detached: false, root: true },
          { pid: 6131, ppid: 6120, name: 'python', state: 'S', cmd: 'python -c from multiprocessing.spawn import spawn_main', cpu: 45, rss: 1.1e9, started: t - 5 * 3600 + 20, detached: false, root: false },
          { pid: 6132, ppid: 6120, name: 'python', state: 'S', cmd: 'python -c from multiprocessing.spawn import spawn_main', cpu: 44, rss: 1.1e9, started: t - 5 * 3600 + 20, detached: false, root: false },
          { pid: 6300, ppid: 0, name: 'tensorboard', state: 'S', cmd: 'tensorboard --logdir runs --port 6006', cpu: 0.6, rss: 210e6, started: t - 4 * 3600, detached: true, root: false },
        ] }),
      session({ id: 'd3', name: 'codex: API docs', type: 'codex', cwd: '/home/dev/src/api-gateway', command: 'codex', pid: 7010, created: now() - 1800, started: now() - 1800,
        processes: [{ pid: 7010, ppid: 2211, name: 'codex', state: 'S', cmd: 'codex', cpu: 0.3, rss: 260e6, started: t - 1800, detached: false, root: true }],
        activity: { kind: 'codex', status: 'idle', current_tool: null, pending_tools: [], last_text: 'Docs regenerated for all 14 endpoints; two examples still reference the v1 auth header — want me to update them?', last_prompt: 'Regenerate the OpenAPI docs from the handlers', last_ts: iso(400), model: 'gpt-5.6', usage: { input: 900000, output: 6100, cache_read: 620000, total: 906100 }, title: 'Regenerate API docs', turns: 3, tool_calls: 28, session_id: '0190-codex', transcript: null, age: 400, subagents: [] } }),
      session({ id: 'd4', name: 'flaky test hunt', type: 'claude', cwd: '/home/dev/src/api-gateway', command: 'claude --session-id 77ab…', pid: 0, status: 'exited', exit_code: 0, ended: now() - 5400, created: now() - 9000, started: now() - 9000, has_pty: false, activity: null }),
    ],
    history: Array.from({ length: 60 }, (_, i) => ({ t: Date.now() - (60 - i) * 2000, cpu: 30 + 12 * Math.sin(i / 5) + (i % 3), mem: 47 + (i % 4), gpu: 85 + 8 * Math.sin(i / 3), vram: 78 + (i % 2) })),
  };
  const jetson: MachineState = {
    config: { id: 'demo-jetson', name: 'jetson-orin', transport: 'ssh', host: '10.0.0.42', user: 'nvidia', proxyJump: 'dev@lab-gw', createdAt: 0 },
    status: 'connected', error: null, authMethod: 'publickey', hasPassword: false, connectedAt: Date.now() - 600e3, lastUpdate: Date.now(),
    hello: { version: '0.1.4', protocol: 1, pid: 1499, hostname: 'jetson-orin', user: 'nvidia', home: '/home/nvidia', shell: '/bin/bash', os: 'Ubuntu 22.04 LTS (JetPack 6)', arch: 'aarch64', python: '3.10.12',
      tools: { claude: '/home/nvidia/.npm-global/bin/claude', codex: null, opencode: null, tmux: null, git: '/usr/bin/git', 'nvidia-smi': null, python3: '/usr/bin/python3' }, subreaper: true, gpu_kind: 'jetson', sock: '/home/nvidia/.hostler/helper.sock', started: t - 600 },
    resources: { cpu_pct: 62, cores: 12, load: [7.9, 6.2, 5.0], mem_total: 64e9, mem_used: 21e9, mem_available: 43e9, swap_total: 32e9, swap_used: 0, disk: { path: '/home/nvidia', total: 1e12, free: 0.6e12 }, uptime: 86400 * 3,
      gpus: [{ index: 0, name: 'NVIDIA Jetson AGX Orin', util: 54, mem_used: 21e9, mem_total: 64e9, temp: 58, power: null, shared: true }], gpu_kind: 'jetson' },
    discovered: [],
    sessions: [
      session({ id: 'j1', name: 'port inference node', type: 'claude', cwd: '/home/nvidia/ros2_ws', command: 'claude --session-id 9c0d…', pid: 3311,
        processes: [{ pid: 3311, ppid: 1499, name: 'node', state: 'S', cmd: 'claude --session-id 9c0d…', cpu: 6, rss: 380e6, started: t - 1200, detached: false, root: true }],
        activity: { kind: 'claude', status: 'thinking', current_tool: null, pending_tools: [], last_text: null, last_prompt: 'Port the TensorRT inference node to ROS 2 Humble and keep latency under 20 ms', last_ts: iso(8), model: 'claude-opus-5', usage: { input: 800, output: 5200, cache_read: 150000 }, title: 'ROS 2 inference node', turns: 2, tool_calls: 31, session_id: '9c0d…', transcript: null, age: 8, subagents: [] } }),
    ],
    history: Array.from({ length: 60 }, (_, i) => ({ t: Date.now() - (60 - i) * 2000, cpu: 55 + 10 * Math.sin(i / 4), mem: 33, gpu: 50 + 20 * Math.sin(i / 6), vram: 33 })),
  };
  const laptop: MachineState = {
    config: { id: 'demo-ws', name: 'lab-workstation', transport: 'ssh', host: 'lab-ws-03', user: 'dev', createdAt: 0 },
    status: 'error', error: 'connection lost', needsPassword: false, hasPassword: false, sessions: [], discovered: [],
  };
  const hpc: MachineState = {
    config: { id: 'demo-hpc', name: 'hpc-login', transport: 'ssh', host: 'login.cluster.example', user: 'dev', createdAt: 0, keyInstalled: false },
    status: 'connected', error: null, authMethod: 'password', hasPassword: true, connectedAt: Date.now() - 1200e3, lastUpdate: Date.now(),
    hello: { version: '0.1.5', protocol: 1, pid: 9931, hostname: 'login1', user: 'dev', home: '/home/dev', shell: '/bin/bash', os: 'Rocky Linux 9.4', arch: 'x86_64', python: '3.9.18',
      tools: { claude: '/home/dev/.local/bin/claude', codex: null, opencode: null, tmux: '/usr/bin/tmux', git: '/usr/bin/git', curl: '/usr/bin/curl', npm: null, 'nvidia-smi': null, python3: '/usr/bin/python3' },
      subreaper: true, gpu_kind: null, cluster: { kind: 'slurm', tools: { sinfo: '/usr/bin/sinfo', squeue: '/usr/bin/squeue', sbatch: '/usr/bin/sbatch' } },
      sock: '/tmp/hostler-5001/helper.sock', started: t - 1200 },
    resources: { cpu_pct: 8, cores: 64, load: [2.1, 1.8, 1.7], mem_total: 256e9, mem_used: 31e9, mem_available: 225e9, swap_total: 0, swap_used: 0,
      disk: { path: '/home/dev', total: 39e12, free: 35e12 }, uptime: 86400 * 61, gpus: [] },
    discovered: [],
    sessions: [
      session({ id: 'h1', name: 'prepare sweep configs', type: 'claude', cwd: '/home/dev/experiments', command: 'claude --session-id 41ab…', pid: 8801,
        processes: [{ pid: 8801, ppid: 9931, name: 'node', state: 'S', cmd: 'claude --session-id 41ab…', cpu: 3, rss: 350e6, started: t - 900, detached: false, root: true }],
        activity: { kind: 'claude', status: 'idle', current_tool: null, pending_tools: [], last_text: 'Wrote 12 sbatch scripts under experiments/sweeps/ and submitted the first two.', last_prompt: 'Generate the sbatch files for the lr sweep', last_ts: iso(120),
          model: 'claude-opus-5', usage: { input: 2100, output: 9400, cache_read: 210000 }, title: 'Slurm sweep scripts', turns: 4, tool_calls: 22, session_id: '41ab-1', transcript: null, age: 120, subagents: [] } }),
    ],
    history: Array.from({ length: 60 }, (_, i) => ({ t: Date.now() - (60 - i) * 2000, cpu: 6 + 4 * Math.sin(i / 7), mem: 12, gpu: 0, vram: 0 })),
  };
  const workspaces: WorkspaceConfig[] = [
    { id: 'w1', machineId: 'demo-gpu', path: '/home/dev/src/vision-pipeline', name: 'vision-pipeline', createdAt: 0 },
    { id: 'w2', machineId: 'demo-gpu', path: '/home/dev/src/api-gateway', name: 'api-gateway', createdAt: 0 },
    { id: 'w3', machineId: 'demo-jetson', path: '/home/nvidia/ros2_ws', name: 'ros2_ws', createdAt: 0 },
    { id: 'w4', machineId: 'demo-hpc', path: '/home/dev/experiments', name: 'experiments', createdAt: 0 },
  ];
  return { machines: [gpu, jetson, hpc, laptop], workspaces };
}

/** Synthetic `cluster.status` for the demo login node. */
export function demoCluster() {
  return {
    kind: 'slurm',
    // total = what the partition owns, alloc = held by jobs, idle/avail = what a job could get now (the 2 down gpu nodes count in neither)
    partitions: [
      { name: 'gpu', default: true, avail: 'up', nodes: 18, nodes_avail: 16, states: { idle: 4, mixed: 12, down: 2 }, cpus: { alloc: 380, idle: 644, other: 128, total: 1152 }, gpus: { alloc: 46, idle: 18, total: 72 }, mem: { alloc: 5.2e12, avail: 3.0e12, total: 9.2e12 }, gres: 'gpu:a100:4', limit: '2-00:00:00' },
      { name: 'cpu', default: false, avail: 'up', nodes: 48, nodes_avail: 48, states: { allocated: 40, idle: 8 }, cpus: { alloc: 2560, idle: 512, other: 0, total: 3072 }, gpus: { alloc: 0, idle: 0, total: 0 }, mem: { alloc: 9.8e12, avail: 2.5e12, total: 12.3e12 }, gres: null, limit: '7-00:00:00' },
      { name: 'debug', default: false, avail: 'up', nodes: 2, nodes_avail: 2, states: { idle: 2 }, cpus: { alloc: 0, idle: 128, other: 0, total: 128 }, gpus: { alloc: 0, idle: 8, total: 8 }, mem: { alloc: 0, avail: 1.0e12, total: 1.0e12 }, gres: 'gpu:a100:4', limit: '30:00' },
    ],
    jobs: [
      { id: '1842317', partition: 'gpu', name: 'train-resnet-seed3', state: 'RUNNING', time: '4:21:07', limit: '1-00:00:00', nodes: 1, reason: 'node[07]', cpus: 32, gpus: 4, nodelist: 'node07', submitted: '2026-08-27T18:02:11' },
      { id: '1842401', partition: 'gpu', name: 'sweep-lr', state: 'PENDING', time: '0:00', limit: '8:00:00', nodes: 2, reason: '(Resources)', cpus: 64, gpus: 8, nodelist: '', submitted: '2026-08-27T22:40:03' },
      { id: '1842402', partition: 'cpu', name: 'preprocess-shards', state: 'RUNNING', time: '18:44', limit: '2:00:00', nodes: 1, reason: 'node[41]', cpus: 16, gpus: 0, nodelist: 'node41', submitted: '2026-08-27T22:21:40' },
    ],
    recent: [
      { id: '1842301', name: 'smoke-test', partition: 'gpu', state: 'FAILED', elapsed: '00:00:31', exit: '1:0', end: '2026-08-27T21:03:44' },
      { id: '1842290', name: 'preprocess-shards', partition: 'cpu', state: 'COMPLETED', elapsed: '00:18:44', exit: '0:0', end: '2026-08-27T20:11:02' },
    ],
    summary: {
      nodes: { total: 68, idle: 14, avail: 66 },
      cpus: { total: 4352, alloc: 2940, idle: 1284, other: 128 },
      gpus: { total: 80, alloc: 46, idle: 26 },
      mem: { total: 22.5e12, alloc: 15.0e12, avail: 6.5e12 },
      queue: { running: 214, pending: 87, other: 3 },
      mine: { running: 2, pending: 1 },
    },
    error: null,
  };
}

/** Synthetic `history.list` answers so the demo shows resumable past conversations. */
export function demoHistory(cwd: string) {
  const t = now();
  const rows: { type: 'claude' | 'codex'; session_id: string; title: string; prompt: string; ago: number; size: number; model: string; branch: string }[] = [
    { type: 'claude', session_id: '5e1c0a9b-1', title: 'Deterministic data loader', prompt: 'Make the data loader deterministic under num_workers>0', ago: 40, size: 2.1e6, model: 'claude-opus-5', branch: 'fix/loader-seed' },
    { type: 'claude', session_id: 'c31f77ae-9', title: 'Mixed-precision training pass', prompt: 'Switch the trainer to bf16 and check for loss spikes', ago: 26 * 3600, size: 5.4e6, model: 'claude-opus-5', branch: 'main' },
    { type: 'codex', session_id: '0190-codex', title: 'Regenerate API docs', prompt: 'Regenerate the OpenAPI docs from the handlers', ago: 400, size: 0.9e6, model: 'gpt-5.6', branch: 'main' },
    { type: 'claude', session_id: 'ab77e201-4', title: 'Flaky test hunt', prompt: 'tests/loader/test_shuffle.py fails once every ~20 runs — find out why', ago: 5 * 86400, size: 3.2e6, model: 'claude-sonnet-5', branch: 'main' },
  ];
  return rows.map((r) => ({
    type: r.type, session_id: r.session_id, path: `${cwd}/.transcripts/${r.session_id}.jsonl`, cwd,
    mtime: t - r.ago, size: r.size, resumable: true, title: r.title, prompt: r.prompt, last_prompt: r.prompt,
    created: iso(r.ago + 3600), last_ts: iso(r.ago), branch: r.branch, model: r.model,
  }));
}

/** Jitter resource numbers a little so the demo feels alive. */
export function tickDemo(m: MachineState) {
  const r = m.resources;
  if (!r) return;
  const j = (v: number, a: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * a));
  r.cpu_pct = j(r.cpu_pct, 6);
  for (const g of r.gpus) if (g.util != null) g.util = j(g.util, 8);
  const g = r.gpus[0];
  m.history = [...(m.history || []).slice(-119), { t: Date.now(), cpu: r.cpu_pct, mem: (100 * r.mem_used) / r.mem_total, gpu: g?.util ?? 0, vram: g ? (100 * g.mem_used) / g.mem_total : 0 }];
  m.lastUpdate = Date.now();
}
