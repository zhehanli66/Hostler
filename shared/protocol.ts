// UI <-> control plane websocket protocol (JSON messages)
import type { MachineState, WorkspaceConfig } from './types';

export interface WsRequest { id: number; op: string; [k: string]: any }
export interface WsResponse { id: number; ok: boolean; result?: any; error?: string }
export type WsEvent =
  | { ev: 'hello'; version: string }
  | { ev: 'state'; machines: MachineState[]; workspaces: WorkspaceConfig[] }
  | { ev: 'machine'; machine: MachineState }
  | { ev: 'machine.removed'; id: string }
  | { ev: 'workspaces'; workspaces: WorkspaceConfig[] }
  | { ev: 'output'; machineId: string; session: string; data: string }
  | { ev: 'session.exit'; machineId: string; id: string; exit_code: number | null; signal: number | null }
  | { ev: 'session.created'; machineId: string; session: any }
  | { ev: 'session.removed'; machineId: string; id: string }
  | { ev: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export const DEFAULT_PORT = 7788;
