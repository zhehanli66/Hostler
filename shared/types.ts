// Data model shared by the control plane (server), the Electron shell and the UI.
// Machine -> Workspace -> Agent (session) -> Subagent -> Process

export type AgentType = 'claude' | 'codex' | 'opencode' | 'shell' | 'custom';
export type MachineStatus = 'disconnected' | 'connecting' | 'deploying' | 'connected' | 'error';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'adopted' | 'lost';
export type ActivityStatus = 'tool' | 'thinking' | 'subagents' | 'idle' | 'unknown' | 'error';

export interface MachineConfig {
  id: string;
  name: string;
  transport: 'ssh' | 'local';
  host?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  /** In-memory only. Never written to disk in plain text. */
  password?: string;
  /** Password encrypted with the OS keychain (Electron safeStorage); only when savePassword is set. */
  passwordEnc?: string;
  savePassword?: boolean;
  /** Set once Hostler installed the local public key on this machine. */
  keyInstalled?: boolean;
  proxyJump?: string;
  pythonPath?: string;
  autoConnect?: boolean;
  color?: string;
  createdAt: number;
}

export interface WorkspaceConfig {
  id: string;
  machineId: string;
  path: string;
  name: string;
  createdAt: number;
}

export interface HelperHello {
  version: string;
  protocol: number;
  pid: number;
  hostname: string;
  user: string;
  home: string;
  shell?: string;
  os?: string;
  arch?: string;
  python?: string;
  tools: Record<string, string | null>;
  subreaper: boolean;
  gpu_kind?: 'nvidia' | 'jetson' | null;
  /** set when the machine can talk to a batch scheduler, i.e. it is a cluster login/submit node */
  cluster?: ClusterInfo | null;
  sock: string;
  started: number;
}

export interface ClusterInfo { kind: string; tools: Record<string, string | null> }

export interface ClusterPartition {
  name: string;
  /** the scheduler's default partition */
  default?: boolean;
  avail: string;
  nodes: number;
  /** node count per scheduler state: idle / mixed / allocated / down … */
  states: Record<string, number>;
  cpus?: { alloc: number; idle: number; other: number; total: number } | null;
  /** total from the node list, alloc from the running jobs */
  gpus?: { alloc: number; idle: number; total: number };
  gres?: string | null;
  /** the partition's max wall time */
  limit?: string | null;
}

export interface ClusterJob {
  id: string; partition: string; name: string; state: string;
  /** elapsed and the job's wall-time limit */
  time: string; limit: string;
  nodes: number;
  /** node list for a running job, the pending reason otherwise */
  reason: string;
  cpus?: number; gpus?: number; nodelist?: string; submitted?: string;
}

export interface ClusterRecentJob { id: string; name: string; partition: string; state: string; elapsed: string; exit: string; end: string }

export interface ClusterSummary {
  nodes: { total: number; idle: number };
  gpus: { total: number; alloc: number };
  /** the whole cluster's queue, all users */
  queue: { running: number; pending: number; other: number };
  mine: { running: number; pending: number };
}

/** `scontrol show job` for one job */
export interface ClusterJobDetail {
  id: string;
  fields: Record<string, string>;
  stdout?: string | null; stderr?: string | null; workdir?: string | null; nodelist?: string | null; state?: string | null;
  raw?: string;
}

export interface ClusterStatus {
  kind: string | null;
  partitions: ClusterPartition[];
  jobs: ClusterJob[];
  /** today's finished jobs (sacct), newest first */
  recent?: ClusterRecentJob[];
  summary?: ClusterSummary;
  error?: string | null;
  /** a scheduler Hostler does not parse yet */
  unsupported?: boolean;
}

export interface GpuInfo {
  index: number;
  name: string;
  util: number | null;
  mem_used: number;
  mem_total: number;
  temp?: number | null;
  power?: number | null;
  shared?: boolean;
}

export interface Resources {
  cpu_pct: number;
  cores: number;
  load: [number, number, number];
  mem_total: number;
  mem_used: number;
  mem_available: number;
  swap_total: number;
  swap_used: number;
  disk?: { path: string; total: number; free: number } | null;
  uptime: number;
  gpus: GpuInfo[];
  gpu_kind?: 'nvidia' | 'jetson' | null;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  cmd: string;
  cpu: number;
  rss: number;
  gpu_mem?: number | null;
  started: number;
  detached: boolean;
  root: boolean;
}

export interface PendingTool {
  id?: string;
  name: string;
  summary?: string | null;
  ts?: string | null;
}

export interface ConversationActivity {
  status: ActivityStatus;
  current_tool?: PendingTool | null;
  pending_tools: PendingTool[];
  last_text?: string | null;
  last_prompt?: string | null;
  last_ts?: string | null;
  model?: string | null;
  usage?: { input?: number; output?: number; cache_read?: number; cache_write?: number; total?: number } | null;
  title?: string | null;
  turns: number;
  tool_calls: number;
  session_id?: string | null;
}

export interface Subagent {
  id: string;
  tool_use_id?: string;
  type?: string | null;
  description?: string | null;
  started?: string | null;
  status: 'running' | 'completed';
  async?: boolean;
  activity?: ConversationActivity;
}

export interface Activity extends ConversationActivity {
  kind: AgentType | string;
  transcript?: string | null;
  age?: number | null;
  subagents: Subagent[];
  error?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  type: AgentType;
  cwd: string;
  workspace: string;
  command?: string | null;
  pid?: number | null;
  status: SessionStatus;
  exit_code?: number | null;
  exit_signal?: number | null;
  created: number;
  started?: number | null;
  ended?: number | null;
  cols: number;
  rows: number;
  adopted: boolean;
  tmux_target?: string | null;
  meta: Record<string, any>;
  restarts: number;
  last_output?: number | null;
  error?: string | null;
  has_pty: boolean;
  processes: ProcessInfo[];
  scrollback_bytes: number;
  activity?: Activity | null;
}

export interface DiscoveredProcess {
  pid: number;
  type: AgentType;
  cmd: string;
  args?: string | null;
  cwd?: string | null;
  started: number;
  tty?: string | null;
  tmux_target?: string | null;
  cpu: number;
  rss: number;
  background: boolean;
  user?: string;
}

export interface ResourceSample { t: number; cpu: number; mem: number; gpu: number; vram: number }

export interface MachineState {
  config: MachineConfig;
  /** recent resource samples (control-plane side, survives UI reloads) */
  history?: ResourceSample[];
  status: MachineStatus;
  error?: string | null;
  hello?: HelperHello | null;
  resources?: Resources | null;
  sessions: SessionInfo[];
  discovered: DiscoveredProcess[];
  lastUpdate?: number;
  helperUpgradePending?: string | null;
  helperVersionLocal?: string;
  connectedAt?: number;
  /** ssh auth method that succeeded on the last connect (agent / publickey / password / keyboard-interactive) */
  authMethod?: string | null;
  /** last connect failed with an authentication error; the UI should ask for a password */
  needsPassword?: boolean;
  /** a password is available (memory or encrypted store) without being exposed to the UI */
  hasPassword?: boolean;
}

/** 'keychain' = OS keychain via Electron safeStorage; 'none' = browser mode or no usable keyring (passwords stay in memory) */
export type SecretBackend = 'keychain' | 'none';

export interface AppCapabilities {
  /** how saved passwords are protected: OS keychain, or not available (browser mode / no keyring) */
  secretStorage: SecretBackend;
  desktop: boolean;
}

export interface AppState {
  version: string;
  machines: MachineState[];
  workspaces: WorkspaceConfig[];
  capabilities: AppCapabilities;
}

export interface SshHostEntry {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

export interface GitStatus {
  available: boolean;
  repo?: boolean;
  error?: string;
  top?: string;
  branch?: { head: string | null; upstream: string | null; ahead: number; behind: number };
  files?: { xy: string; path: string; staged: boolean; unstaged: boolean; untracked?: boolean; conflict?: boolean }[];
  file_count?: number;
  commits?: { hash: string; author: string; when: string; subject: string }[];
  diff?: string;
  diff_staged?: string;
}

export interface FsEntry { name: string; dir: boolean; size: number; mtime: number; git?: boolean }
export interface FsList { path: string; parent: string | null; entries: FsEntry[]; git?: boolean; error?: string }

export interface NewSessionSpec {
  type: AgentType;
  name?: string;
  cwd: string;
  workspace?: string;
  args?: string;
  command?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** continue a past conversation instead of starting a fresh one (claude --resume / codex resume / opencode --session) */
  resume?: boolean;
  resume_id?: string;
}

/** A past agent conversation, read from the agent's own transcript on the machine. */
export interface HistoryEntry {
  type: AgentType;
  session_id: string;
  /** transcript file (or session json for opencode) */
  path: string;
  cwd: string;
  /** last write to the transcript, epoch seconds */
  mtime: number;
  size: number;
  resumable: boolean;
  title?: string | null;
  /** first prompt of the conversation */
  prompt?: string | null;
  last_prompt?: string | null;
  created?: string | null;
  last_ts?: string | null;
  branch?: string | null;
  model?: string | null;
}
