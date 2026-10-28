/**
 * Edge Command Protocol Types (Frontend Mirror of shared/protocol.ts)
 */

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_V = 1;

export type RunStatus =
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'interrupted'
  | 'unknown'
  | 'skipped_offline'
  | 'skipped_busy';

export const TERMINAL_RUN_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'interrupted',
  'unknown',
  'skipped_offline',
  'skipped_busy',
] as const satisfies readonly RunStatus[];

export const ACTIVE_RUN_STATUSES = [
  'dispatching',
  'accepted',
  'running',
] as const satisfies readonly RunStatus[];

export type TerminalStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export type ActiveStatus = (typeof ACTIVE_RUN_STATUSES)[number];
export type FinishedStatus = 'succeeded' | 'failed' | 'timed_out' | 'interrupted';

export interface Agent {
  id: string;
  name: string;
  hostname?: string;
  groupIds: string[];
  disabled: boolean;
  online: boolean;
  version?: string;
  currentRunId?: string;
  latencyMs?: number;
  latencyMeasuredAt?: number;
  createdAt: number;
}

export interface Group {
  id: string;
  name: string;
}

export interface Batch {
  id: string;
  requestId: string;
  command: string;
  timeoutSec: number;
  createdAt: number;
}

export interface Run {
  id: string;
  batchId: string;
  agentId: string;
  agentName: string;
  status: RunStatus;
  lastSeq: number;
  exitCode?: number;
  reason?: string;
  outputTruncated?: boolean;
  createdAt: number;
  finishedAt?: number;
}

export interface Enrollment {
  id: string;
  name: string;
  groupIds: string[];
  maxAgents: number;
  registeredCount: number;
  expiresAt: number;
  revoked: boolean;
  createdAt: number;
}

export interface InstallInfo {
  command: string;
  link: string;
  script: string;
}

export type EventKind = 'accepted' | 'started' | 'output' | 'finished';
export type EventStream = 'stdout' | 'stderr';

export interface RunEvent {
  v: typeof PROTOCOL_VERSION;
  type: 'event';
  runId: string;
  seq: number;
  kind: EventKind;
  stream?: EventStream;
  dataBase64?: string;
  status?: FinishedStatus;
  exitCode?: number;
  reason?: string;
  outputTruncated?: boolean;
}

export interface ChangedFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'changed';
  batchId?: string;
  runId?: string;
  lastSeq?: number;
}

export interface AgentsChangedFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'agents_changed';
}

export type BrowserFrame = ChangedFrame | AgentsChangedFrame;

export interface LoginResult {
  authenticated: true;
  identity: string;
}

export interface UsageLimits {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  logFrames: number;
  storageBytes: number;
}

export interface Usage {
  day: string;
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  logFrames: number;
  storageBytes: number;
  limits: UsageLimits;
  limited: boolean;
}

export interface AgentListResponse {
  agents: Agent[];
}

export interface GroupListResponse {
  groups: Group[];
}

export interface EnrollmentListResponse {
  enrollments: Enrollment[];
}

export interface BatchListResponse {
  batches: Batch[];
  nextCursor: string | null;
}

export interface BatchDetailResponse {
  batch: Batch;
  runs: Run[];
}

export interface EventsResponse {
  events: RunEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export type ErrorResponse = { error: string };
