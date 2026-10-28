/**
 * Edge Command Panel wire contracts (v1).
 *
 * This file is intentionally dependency-free so Worker, tests and tooling can
 * share it. All timestamps are epoch milliseconds in UTC.
 */

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_V = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_TARGETS = 100;
export const DEFAULT_TIMEOUT_SEC = 300;
export const MAX_TIMEOUT_SEC = 3600;
export const ACCEPT_WINDOW_MS = 30_000;
export const RUN_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const TOTAL_STORAGE_LIMIT_BYTES = 256 * 1024 * 1024;
export const DAILY_LOG_FRAME_LIMIT = 10_000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_WS_MAX_MS = 15 * 60 * 1000;
/** Agent keepalive uses WebSocket control PING; browser uses text "ping"/auto-"pong". */
export const AGENT_ONLINE_MS = 90_000;
export const PROBE_MERGE_MS = 15_000;
export const ENROLL_CHALLENGE_MS = 60_000;

export type RunStatus =
  | "dispatching"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "unknown"
  | "skipped_offline"
  | "skipped_busy";

export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "unknown",
  "skipped_offline",
  "skipped_busy",
] as const satisfies readonly RunStatus[];

export const ACTIVE_RUN_STATUSES = [
  "dispatching",
  "accepted",
  "running",
] as const satisfies readonly RunStatus[];

export type TerminalStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export type ActiveStatus = (typeof ACTIVE_RUN_STATUSES)[number];
export type FinishedStatus = "succeeded" | "failed" | "timed_out" | "interrupted";

export interface Agent {
  id: string;
  name: string;
  hostname?: string;
  groupIds: string[];
  disabled: boolean;
  online: boolean;
  version?: string;
  currentRunId?: string;
  /** End-to-end RTT, kept in the live WebSocket attachment, never in SQL. */
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
  /** Safe copy/paste shell command; may contain the one-shot credentials. */
  command: string;
  /** PUBLIC_URL + "/install#" + base64url(JSON.stringify({command})) */
  link: string;
  /** Install script body. Secret-bearing; callers must never cache or log it. */
  script: string;
}

export type EventKind = "accepted" | "started" | "output" | "finished";
export type EventStream = "stdout" | "stderr";

export interface RunEvent {
  v: typeof PROTOCOL_VERSION;
  type: "event";
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

/** Server -> agent frames. */
export interface WelcomeFrame {
  v: typeof PROTOCOL_VERSION;
  type: "welcome";
  connectionId: string;
}

export interface ExecuteFrame {
  v: typeof PROTOCOL_VERSION;
  type: "execute";
  runId: string;
  command: string;
  timeoutSec: number;
  acceptBefore: number;
}

export interface AckFrame {
  v: typeof PROTOCOL_VERSION;
  type: "ack";
  runId: string;
  throughSeq: number;
}

export interface ProbeFrame {
  v: typeof PROTOCOL_VERSION;
  type: "probe";
  probeId: string;
}

export interface PauseFrame {
  v: typeof PROTOCOL_VERSION;
  type: "pause";
  /** Milliseconds until output may be retried. Finish frames stay available. */
  retryAfter: number;
}

export type ServerFrame = WelcomeFrame | ExecuteFrame | AckFrame | ProbeFrame | PauseFrame;

/** Agent -> server JSON frames. "ping" is a separate plain-text frame. */
export interface HelloRun {
  runId: string;
  state: string;
  lastSeq: number;
}

export interface HelloFrame {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  bootId: string;
  version: string;
  hostname: string;
  runs?: HelloRun[];
}

export interface EventFrame {
  v: typeof PROTOCOL_VERSION;
  type: "event";
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

export interface ProbeReplyFrame {
  v: typeof PROTOCOL_VERSION;
  type: "probe_reply";
  probeId: string;
}

export type AgentFrame = HelloFrame | EventFrame | ProbeReplyFrame;

/** Browser notification frames (never executable). */
export interface ChangedFrame {
  v: typeof PROTOCOL_VERSION;
  type: "changed";
  batchId?: string;
  runId?: string;
  lastSeq?: number;
}

export interface AgentsChangedFrame {
  v: typeof PROTOCOL_VERSION;
  type: "agents_changed";
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
export interface EventsResponse {
  events: RunEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export type ErrorResponse = { error: string };
