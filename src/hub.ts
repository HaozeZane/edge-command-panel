import type {
  Agent,
  AgentFrame,
  Batch,
  BrowserFrame,
  Enrollment,
  EventStream,
  FinishedStatus,
  InstallInfo,
  Run,
  RunEvent,
  RunStatus,
  ServerFrame,
  Usage,
} from "../shared/protocol";
import {
  ACCEPT_WINDOW_MS,
  AGENT_ONLINE_MS,
  BROWSER_WS_MAX_MS,
  DAILY_LOG_FRAME_LIMIT,
  DEFAULT_TIMEOUT_SEC,
  ENROLL_CHALLENGE_MS,
  MAX_COMMAND_BYTES,
  MAX_FRAME_BYTES,
  MAX_TARGETS,
  MAX_TIMEOUT_SEC,
  PROBE_MERGE_MS,
  PROTOCOL_V,
  RETENTION_MS,
  RUN_OUTPUT_LIMIT_BYTES,
  TOTAL_STORAGE_LIMIT_BYTES,
} from "../shared/protocol";
import {
  CloudflareAccessApi,
  CloudflareApiError,
  ConfigError,
  SERVICE_TOKEN_LIMIT,
  provisionConfig,
  type CfServiceToken,
} from "./cloudflare";
import {
  decryptSecret,
  encryptSecret,
  tokenMatches,
  validEncryptionKey,
  verifyEd25519,
} from "./crypto";
import type { Env } from "./types";
import {
  ValidationError,
  asBoolean,
  asInt,
  asString,
  asStringArray,
  asUuid,
  b64Decode,
  b64Encode,
  b64urlDecode,
  b64urlEncode,
  canonicalJson,
  clampInt,
  encoder,
  errorResponse,
  isRecord,
  isStrictBase64,
  json,
  makeCursor,
  nowMs,
  parseBody,
  parseCursor,
  parseJsonColumn,
  randomId,
  randomToken,
  sha256Hex,
  shellQuote,
} from "./util";

const GRACE_MS = 10_000;
const HELLO_TIMEOUT_MS = 15_000;
const CURSOR_LIMIT = 50;
const EVENT_PAGE_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_SQL = "('dispatching','accepted','running')";
const TERMINAL_SQL =
  "('succeeded','failed','timed_out','interrupted','unknown','skipped_offline','skipped_busy')";

interface AgentAttachment {
  kind: "agent";
  agentId: string;
  connectionId: string;
  hello: boolean;
  connectedAt: number;
  lastSeenAt: number;
  authDeadline: number;
  closing?: boolean;
  probeId?: string;
  probeSentAt?: number;
  lastProbeAt?: number;
  latencyMs?: number;
  latencyMeasuredAt?: number;
}

interface BrowserAttachment {
  kind: "browser";
  expiresAt: number;
  identity: string;
  closing?: boolean;
}

type SocketAttachment = AgentAttachment | BrowserAttachment;

interface AgentRow {
  id: string;
  name: string;
  name_is_manual: number;
  hostname: string | null;
  version: string | null;
  group_ids: string;
  disabled: number;
  access_client_id: string;
  access_token_id: string | null;
  previous_token_id: string | null;
  token_cipher: string | null;
  installation_id: string | null;
  public_key: string | null;
  boot_id: string | null;
  connection_id: string | null;
  connected_at: number | null;
  last_hello_at: number | null;
  created_at: number;
}

interface GroupRow {
  id: string;
  name: string;
}

interface BatchRow {
  id: string;
  request_id: string;
  payload: string;
  command: string;
  timeout_sec: number;
  created_at: number;
  all_done: number;
}

interface RunRow {
  id: string;
  batch_id: string;
  agent_id: string;
  agent_name: string;
  status: RunStatus;
  last_seq: number;
  exit_code: number | null;
  reason: string | null;
  output_truncated: number;
  created_at: number;
  accepted_at: number | null;
  started_at: number | null;
  deadline_at: number | null;
  accept_deadline: number | null;
  finished_at: number | null;
  output_bytes: number;
  timeout_sec: number;
}

interface EnrollmentRow {
  id: string;
  request_id: string;
  name: string;
  group_ids: string;
  max_agents: number;
  registered_count: number;
  expires_at: number;
  revoked: number;
  access_client_id: string;
  access_token_id: string | null;
  token_cipher: string | null;
  created_at: number;
}

interface EventRow {
  run_id: string;
  seq: number;
  kind: string;
  stream: string | null;
  data: string | null;
  status: string | null;
  exit_code: number | null;
  reason: string | null;
  output_truncated: number;
  created_at: number;
}

interface UsageRow {
  day: string;
  requests: number;
  rows_read: number;
  rows_written: number;
  log_frames: number;
  storage_bytes: number;
}

interface ProvisionRequestRow {
  request_id: string;
  kind: string;
  payload_hash: string;
  status: string;
  result_id: string | null;
  token_name: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function nextUtcDay(ts = Date.now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function nextCleanupAt(ts = Date.now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 3, 0, 0, 0);
}

function sortUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function agentFromRow(row: AgentRow, now: number, socket?: WebSocket): Agent {
  const attachment = socket ? readAttachment(socket) : null;
  const agent: Agent = {
    id: row.id,
    name: row.name,
    groupIds: parseJsonColumn<string[]>(row.group_ids, []),
    disabled: row.disabled !== 0,
    online: Boolean(socket),
    createdAt: row.created_at,
  };
  if (row.hostname) agent.hostname = row.hostname;
  if (row.version) agent.version = row.version;
  if (socket && attachment?.kind === "agent") {
    if (attachment.latencyMs !== undefined && attachment.latencyMeasuredAt !== undefined) {
      agent.latencyMs = attachment.latencyMs;
      agent.latencyMeasuredAt = attachment.latencyMeasuredAt;
    }
  }
  void now;
  return agent;
}

function runFromRow(row: RunRow): Run {
  const run: Run = {
    id: row.id,
    batchId: row.batch_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    status: row.status,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
  };
  if (row.exit_code !== null) run.exitCode = row.exit_code;
  if (row.reason !== null) run.reason = row.reason;
  if (row.output_truncated !== 0) run.outputTruncated = true;
  if (row.finished_at !== null) run.finishedAt = row.finished_at;
  return run;
}

function batchFromRow(row: BatchRow): Batch {
  return {
    id: row.id,
    requestId: row.request_id,
    command: row.command,
    timeoutSec: row.timeout_sec,
    createdAt: row.created_at,
  };
}

function enrollmentFromRow(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    name: row.name,
    groupIds: parseJsonColumn<string[]>(row.group_ids, []),
    maxAgents: row.max_agents,
    registeredCount: row.registered_count,
    expiresAt: row.expires_at,
    revoked: row.revoked !== 0,
    createdAt: row.created_at,
  };
}

function eventFromRow(row: EventRow): RunEvent {
  const event: RunEvent = {
    v: PROTOCOL_V,
    type: "event",
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind as RunEvent["kind"],
  };
  if (row.stream) event.stream = row.stream as EventStream;
  if (row.data !== null) event.dataBase64 = row.data;
  if (row.status) event.status = row.status as FinishedStatus;
  if (row.exit_code !== null) event.exitCode = row.exit_code;
  if (row.reason !== null) event.reason = row.reason;
  if (row.output_truncated !== 0) event.outputTruncated = true;
  return event;
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    return raw as SocketAttachment;
  } catch {
    return null;
  }
}

function attachmentAgent(ws: WebSocket): AgentAttachment | null {
  const a = readAttachment(ws);
  return a?.kind === "agent" ? a : null;
}

function socketOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function socketClosing(ws: WebSocket, attachment: SocketAttachment | null): boolean {
  return attachment?.closing === true || !socketOpen(ws);
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "interrupted" ||
    status === "unknown" ||
    status === "skipped_offline" ||
    status === "skipped_busy"
  );
}

export class CommandHub implements DurableObject {
  private usageDelta = { requests: 0, reads: 0, writes: 0, logFrames: 0 };
  private provisionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      this.init();
    });
  }

  private sql<T>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
      query,
      ...bindings,
    );
    const rows = cursor.toArray();
    this.usageDelta.reads += cursor.rowsRead;
    this.usageDelta.writes += cursor.rowsWritten;
    return rows as T[];
  }

  private one<T>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T | undefined {
    return this.sql<T>(query, ...bindings)[0];
  }

  private run(query: string, ...bindings: SqlStorageValue[]): void {
    this.sql(query, ...bindings);
  }

  private init(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("PRAGMA foreign_keys = ON");
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_is_manual INTEGER NOT NULL DEFAULT 0,
      hostname TEXT,
      version TEXT,
      group_ids TEXT NOT NULL DEFAULT '[]',
      disabled INTEGER NOT NULL DEFAULT 0,
      access_client_id TEXT NOT NULL UNIQUE,
      access_token_id TEXT,
      previous_token_id TEXT,
      token_cipher TEXT,
      installation_id TEXT UNIQUE,
      public_key TEXT,
      boot_id TEXT,
      connection_id TEXT,
      connected_at INTEGER,
      last_hello_at INTEGER,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      command TEXT NOT NULL,
      timeout_sec INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      all_done INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      reason TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      started_at INTEGER,
      deadline_at INTEGER,
      accept_deadline INTEGER,
      finished_at INTEGER,
      output_bytes INTEGER NOT NULL DEFAULT 0,
      timeout_sec INTEGER NOT NULL DEFAULT 300
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch_id, created_at, id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, created_at DESC)`);
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_agent
      ON runs(agent_id) WHERE status IN ('dispatching','accepted','running')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      stream TEXT,
      data TEXT,
      status TEXT,
      exit_code INTEGER,
      reason TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      group_ids TEXT NOT NULL DEFAULT '[]',
      max_agents INTEGER NOT NULL,
      registered_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      access_client_id TEXT NOT NULL UNIQUE,
      access_token_id TEXT,
      token_cipher TEXT,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS enrollment_challenges (
      challenge TEXT PRIMARY KEY,
      enrollment_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS provision_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      result_id TEXT,
      token_name TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      rows_read INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0,
      log_frames INTEGER NOT NULL DEFAULT 0,
      storage_bytes INTEGER NOT NULL DEFAULT 0
    )`);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO meta(key,value) VALUES('schema','1')",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO meta(key,value) VALUES('next_cleanup_at',?)",
      String(nextCleanupAt()),
    );
  }

  private async flushUsage(force = false): Promise<void> {
    const delta = this.usageDelta;
    if (!force && delta.writes === 0 && delta.logFrames === 0 && delta.requests < 20) return;
    const day = utcDay();
    const dbSize = this.ctx.storage.sql.databaseSize;
    try {
      // The upsert itself is one SQL write; include it in the project-side estimate.
      this.ctx.storage.sql.exec(
        `INSERT INTO usage(day,requests,rows_read,rows_written,log_frames,storage_bytes)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET
           requests=requests+excluded.requests,
           rows_read=rows_read+excluded.rows_read,
           rows_written=rows_written+excluded.rows_written,
           log_frames=log_frames+excluded.log_frames,
           storage_bytes=excluded.storage_bytes`,
        day,
        delta.requests,
        delta.reads,
        delta.writes + 1,
        delta.logFrames,
        dbSize,
      );
    } finally {
      this.usageDelta = { requests: 0, reads: 0, writes: 0, logFrames: 0 };
    }
  }

  private async usageRow(): Promise<UsageRow> {
    const day = utcDay();
    const row = this.one<UsageRow>("SELECT * FROM usage WHERE day=?", day);
    const base = row ?? {
      day,
      requests: 0,
      rows_read: 0,
      rows_written: 0,
      log_frames: 0,
      storage_bytes: this.ctx.storage.sql.databaseSize,
    };
    return {
      ...base,
      requests: base.requests + this.usageDelta.requests,
      rows_read: base.rows_read + this.usageDelta.reads,
      rows_written: base.rows_written + this.usageDelta.writes,
      log_frames: base.log_frames + this.usageDelta.logFrames,
      storage_bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  private limits() {
    return {
      requests: clampInt(this.env.USAGE_REQUESTS_LIMIT, 100_000),
      rowsRead: clampInt(this.env.USAGE_ROWS_READ_LIMIT, 1_000_000),
      rowsWritten: clampInt(this.env.USAGE_ROWS_WRITTEN_LIMIT, 50_000),
      logFrames: clampInt(this.env.USAGE_LOG_FRAMES_LIMIT, DAILY_LOG_FRAME_LIMIT),
      storageBytes: clampInt(this.env.USAGE_STORAGE_BYTES_LIMIT, TOTAL_STORAGE_LIMIT_BYTES),
    };
  }

  private usageFromRow(row: UsageRow): Usage {
    const limits = this.limits();
    return {
      day: utcDay(),
      requests: row.requests,
      rowsRead: row.rows_read,
      rowsWritten: row.rows_written,
      logFrames: row.log_frames,
      storageBytes: row.storage_bytes,
      limits,
      // Keep a small reserve for finishing runs, alarm state transitions and
      // cleanup. These are project-side estimates, not the Cloudflare bill.
      limited:
        row.requests >= Math.max(0, limits.requests - 100) ||
        row.rows_read >= Math.max(0, limits.rowsRead - 5_000) ||
        row.rows_written >= Math.max(0, limits.rowsWritten - 500) ||
        row.log_frames >= limits.logFrames ||
        row.storage_bytes >= Math.max(0, limits.storageBytes - 1024 * 1024),
    };
  }

  async fetch(request: Request): Promise<Response> {
    this.usageDelta.requests += 1;
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof ValidationError) return errorResponse(error.message, 400);
      if (error instanceof ConfigError) return errorResponse(error.message, 503);
      if (error instanceof CloudflareApiError) return errorResponse(error.message, 502);
      if (error instanceof AccessInternalError) {
        return errorResponse(error.message, error.status);
      }
      console.error("hub request failed", error instanceof Error ? error.name : "unknown");
      return errorResponse("internal error", 500);
    } finally {
      await this.flushUsage();
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/internal/agent/ws") return this.handleAgentSocket(request);
    if (path === "/internal/events/ws") return this.handleBrowserSocket(request);
    if (path.startsWith("/internal/agent/")) return this.handleAgentAsset(request, path);
    if (path.startsWith("/internal/enroll/")) return this.handleEnroll(request, path);
    if (path.startsWith("/internal/admin/")) {
      return this.handleAdmin(request, path.slice("/internal/admin".length));
    }
    return errorResponse("not found", 404);
  }

  private role(request: Request): string {
    return request.headers.get("x-ecp-role") ?? "";
  }

  private audit() {
    // Intentionally empty: request bodies and credentials must never be logged.
  }

  // ---------------------------------------------------------------------------
  // Admin API
  // ---------------------------------------------------------------------------

  private async handleAdmin(request: Request, path: string): Promise<Response> {
    const role = this.role(request);
    if (role !== "ui" && role !== "api") {
      return errorResponse("forbidden", 403);
    }
    const method = request.method;
    const url = new URL(request.url);
    this.audit();

    if (method === "GET" && path === "/session") {
      if (role !== "ui") return errorResponse("not found", 404);
      return json({ authenticated: true, identity: request.headers.get("x-ecp-identity") || "" });
    }
    if (path === "/agents/probe" && method === "POST") {
      return this.handleProbe(request);
    }
    if (path === "/agents" && method === "GET") return json({ agents: this.listAgents() });
    if (path === "/agents" && method === "POST") return this.createAgent(request);
    const agentMatch = /^\/agents\/([A-Za-z0-9_-]{1,128})(\/install|\/disable|\/rotate)?$/.exec(path);
    if (agentMatch) {
      const id = agentMatch[1]!;
      const action = agentMatch[2];
      if (!action && method === "PATCH") return this.patchAgent(request, id);
      if (action === "/install" && method === "GET") return this.agentInstallInfo(id);
      if (action === "/disable" && method === "POST") return this.disableAgent(id);
      if (action === "/rotate" && method === "POST") return this.rotateAgent(id);
    }
    if (path === "/groups" && method === "GET") {
      return json({ groups: this.sql<GroupRow>("SELECT id,name FROM groups ORDER BY name,id") });
    }
    if (path === "/groups" && method === "POST") return this.createGroup(request);
    const groupMatch = /^\/groups\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (groupMatch) {
      if (method === "PATCH") return this.patchGroup(request, groupMatch[1]!);
      if (method === "DELETE") return this.deleteGroup(groupMatch[1]!);
    }
    if (path === "/enrollments" && method === "GET") {
      return json({
        enrollments: this.sql<EnrollmentRow>(
          "SELECT * FROM enrollments ORDER BY created_at DESC,id DESC",
        ).map(enrollmentFromRow),
      });
    }
    if (path === "/enrollments" && method === "POST") return this.createEnrollment(request);
    const enrollMatch =
      /^\/enrollments\/([A-Za-z0-9_-]{1,128})(\/install|\/revoke)?$/.exec(path);
    if (enrollMatch) {
      if (enrollMatch[2] === "/install" && method === "GET") {
        return this.enrollmentInstallInfo(enrollMatch[1]!);
      }
      if (enrollMatch[2] === "/revoke" && method === "POST") {
        return this.revokeEnrollment(enrollMatch[1]!);
      }
    }
    if (path === "/batches" && method === "POST") return this.createBatch(request);
    if (path === "/batches" && method === "GET") {
      return this.listBatches(url.searchParams.get("cursor"));
    }
    const batchMatch = /^\/batches\/([A-Za-z0-9_-]{1,128})$/.exec(path);
    if (batchMatch && method === "GET") return this.getBatch(batchMatch[1]!);
    const runEventsMatch = /^\/runs\/([A-Za-z0-9_-]{1,128})\/events$/.exec(path);
    if (runEventsMatch && method === "GET") {
      return this.getEvents(runEventsMatch[1]!, url.searchParams.get("afterSeq"));
    }
    if (path === "/usage" && method === "GET") {
      return json(this.usageFromRow(await this.usageRow()));
    }
    return errorResponse("not found", 404);
  }

  private listAgents(): Agent[] {
    const rows = this.sql<AgentRow>(
      "SELECT * FROM agents ORDER BY created_at DESC,id DESC",
    );
    const current = this.currentRuns();
    return rows.map((row) => {
      const socket = this.currentSocket(row);
      const agent = agentFromRow(row, nowMs(), socket);
      const run = current.get(row.id);
      if (run) agent.currentRunId = run;
      return agent;
    });
  }

  private currentRuns(): Map<string, string> {
    const rows = this.sql<{ agent_id: string; id: string }>(
      `SELECT agent_id,id FROM runs WHERE status IN ${ACTIVE_SQL}`,
    );
    return new Map(rows.map((r) => [r.agent_id, r.id]));
  }

  private activeRun(agentId: string): RunRow | undefined {
    return this.one<RunRow>(
      `SELECT * FROM runs WHERE agent_id=? AND status IN ${ACTIVE_SQL} LIMIT 1`,
      agentId,
    );
  }

  private agentRow(id: string): AgentRow | undefined {
    return this.one<AgentRow>("SELECT * FROM agents WHERE id=?", id);
  }

  private agentByClientId(clientId: string): AgentRow | undefined {
    return this.one<AgentRow>("SELECT * FROM agents WHERE access_client_id=?", clientId);
  }

  private enrollmentByClientId(clientId: string): EnrollmentRow | undefined {
    return this.one<EnrollmentRow>(
      "SELECT * FROM enrollments WHERE access_client_id=?",
      clientId,
    );
  }

  private agentByTokenId(tokenId: string): AgentRow | undefined {
    return this.one<AgentRow>("SELECT * FROM agents WHERE access_token_id=?", tokenId);
  }

  private enrollmentByTokenId(tokenId: string): EnrollmentRow | undefined {
    return this.one<EnrollmentRow>("SELECT * FROM enrollments WHERE access_token_id=?", tokenId);
  }

  private currentSocket(row: AgentRow): WebSocket | undefined {
    if (!row.connection_id) return undefined;
    const sockets = this.ctx.getWebSockets(row.id);
    for (const ws of sockets) {
      const a = attachmentAgent(ws);
      if (
        a &&
        !socketClosing(ws, a) &&
        a.agentId === row.id &&
        a.connectionId === row.connection_id &&
        a.hello &&
        a.authDeadline > nowMs()
      ) {
        return ws;
      }
    }
    return undefined;
  }

  private socketOnline(row: AgentRow): boolean {
    if (row.disabled !== 0) return false;
    return Boolean(this.currentSocket(row));
  }

  private validateGroups(value: unknown): string[] {
    const ids = asStringArray(value, "groupIds");
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const found = this.sql<{ id: string }>(`SELECT id FROM groups WHERE id IN (${placeholders})`, ...ids);
    if (found.length !== ids.length) throw new ValidationError("unknown group id");
    return sortUnique(ids);
  }

  private async createAgent(request: Request): Promise<Response> {
    const body = parseBody(await request.text());
    const requestId = asUuid(body.requestId, "requestId");
    const name =
      body.name === undefined || body.name === null
        ? undefined
        : asString(body.name, "name", 100);
    const groupIds = this.validateGroups(body.groupIds ?? []);
    const canonical = canonicalJson({ name: name ?? null, groupIds });
    const existing = this.one<ProvisionRequestRow>(
      "SELECT * FROM provision_requests WHERE request_id=?",
      requestId,
    );
    if (existing) {
      if (existing.kind !== "agent" || existing.payload_hash !== canonical) {
        return errorResponse("requestId reused with a different payload", 409);
      }
      if (existing.status === "complete" && existing.result_id) {
        const row = this.agentRow(existing.result_id);
        if (row) return json({ agent: this.agentView(row) });
      }
      if (existing.status === "pending" && nowMs() - existing.updated_at < 120_000) {
        return errorResponse("provisioning is already in progress", 409);
      }
      // Failed or stale attempts can be retried; recovery finds the token by its requestId name.
    }
    if (this.usageFromRow(await this.usageRow()).limited) {
      return errorResponse("project usage limit reached", 507);
    }
    const now = nowMs();
    if (!existing) {
      this.run(
        `INSERT INTO provision_requests(request_id,kind,payload_hash,status,token_name,created_at,updated_at)
         VALUES(?,?,?,'pending',?,?,?)`,
        requestId,
        "agent",
        canonical,
        `ecp-a-${requestId}`,
        now,
        now,
      );
    } else {
      this.run(
        "UPDATE provision_requests SET status='pending',updated_at=? WHERE request_id=?",
        now,
        requestId,
      );
    }
    try {
      return await this.enqueueProvision(async () => {
        const config = provisionConfig(this.env);
        const api = new CloudflareAccessApi(config, this.env);
        const tokenName = `ecp-a-${requestId}`;
        const token = await this.obtainToken(api, tokenName, "8760h", {
          kind: "agent",
          appId: config.agentAppId,
          policyId: config.agentPolicyId,
          recoverOrphan: Boolean(existing),
        });
        const recovered = this.agentByClientId(token.client_id);
        if (recovered) {
          this.run(
            "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
            recovered.id,
            nowMs(),
            requestId,
          );
          return json({ agent: this.agentView(recovered) });
        }
        try {
          await api.addServiceTokenToPolicy(
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
          throw error;
        }
        const agentId = randomId("ag");
        const placeholder = name ?? `agent-${agentId.slice(3, 11)}`;
        const cipher = await encryptSecret(
          JSON.stringify({ clientId: token.client_id, clientSecret: token.client_secret }),
          config.encryptionKey,
        );
        try {
          this.ctx.storage.transactionSync(() => {
            this.run(
              `INSERT INTO agents(id,name,name_is_manual,group_ids,disabled,access_client_id,access_token_id,token_cipher,created_at)
               VALUES(?,?,?,?,0,?,?,?,?)`,
              agentId,
              placeholder,
              name ? 1 : 0,
              JSON.stringify(groupIds),
              token.client_id,
              token.id,
              cipher,
              now,
            );
            this.run(
              "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
              agentId,
              now,
              requestId,
            );
          });
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
          throw error;
        }
        this.notifyAgentsChanged();
        const row = this.agentRow(agentId)!;
        return json({ agent: this.agentView(row) });
      });
    } catch (error) {
      const message =
        error instanceof CloudflareApiError || error instanceof ConfigError
          ? error.message
          : "agent provisioning failed";
      this.run(
        "UPDATE provision_requests SET status='failed',error=?,updated_at=? WHERE request_id=?",
        message.slice(0, 300),
        nowMs(),
        requestId,
      );
      if (error instanceof ConfigError) return errorResponse(error.message, 503);
      return errorResponse(message, 502);
    }
  }

  private async obtainToken(
    api: CloudflareAccessApi,
    name: string,
    duration: string | undefined,
    intent: {
      kind: string;
      appId: string;
      policyId: string;
      recoverOrphan: boolean;
    },
  ): Promise<CfServiceToken> {
    const existing = await api.findServiceTokenByName(name);
    if (existing) {
      // A prior attempt may have committed this token to an agent/enrollment.
      // The One list API never returns client_secret, so recover it from the
      // AES-GCM envelope stored with the bound record.
      const boundAgent = this.agentByTokenId(existing.id);
      if (boundAgent) {
        const creds = await this.decryptAgentCreds(boundAgent);
        if (!creds) {
          throw new CloudflareApiError("bound agent credential cannot be decrypted", 500);
        }
        return {
          id: existing.id,
          name: existing.name,
          client_id: boundAgent.access_client_id,
          client_secret: creds.clientSecret,
        };
      }
      const boundEnrollment = this.enrollmentByTokenId(existing.id);
      if (boundEnrollment) {
        if (!boundEnrollment.token_cipher || !validEncryptionKey(this.env.CREDENTIAL_ENCRYPTION_KEY)) {
          throw new CloudflareApiError("bound enrollment credential cannot be decrypted", 500);
        }
        try {
          const creds = JSON.parse(
            await decryptSecret(
              boundEnrollment.token_cipher,
              this.env.CREDENTIAL_ENCRYPTION_KEY,
            ),
          ) as { clientId: string; clientSecret: string };
          return {
            id: existing.id,
            name: existing.name,
            client_id: boundEnrollment.access_client_id,
            client_secret: creds.clientSecret,
          };
        } catch {
          throw new CloudflareApiError("bound enrollment credential cannot be decrypted", 500);
        }
      }

      // Unbound tokens are only ours if the exact name is recorded in a
      // persisted provisioning intent. Never delete by name similarity alone.
      const persisted = this.one<ProvisionRequestRow>(
        "SELECT * FROM provision_requests WHERE token_name=? AND kind=?",
        name,
        intent.kind,
      );
      const previousError = persisted?.error ?? "";
      if (
        !intent.recoverOrphan ||
        !persisted ||
        persisted.token_name !== name ||
        previousError.includes("not owned by this project")
      ) {
        throw new CloudflareApiError(
          "existing Access service token is not owned by this project",
          409,
        );
      }
      // A create response may have been lost. Remove the orphan from the
      // targeted policy, delete it, then create a fresh token with a known secret.
      await this.removePolicyToken(api, intent.appId, intent.policyId, existing.id);
      const remaining = await api.listServiceTokens();
      if (remaining.length + 1 > SERVICE_TOKEN_LIMIT) {
        throw new CloudflareApiError("Cloudflare Access service token capacity is full", 507);
      }
      return api.createServiceToken(name, duration);
    }
    const tokens = await api.listServiceTokens();
    if (tokens.length + 1 > SERVICE_TOKEN_LIMIT) {
      throw new CloudflareApiError("Cloudflare Access service token capacity is full", 507);
    }
    return api.createServiceToken(name, duration);
  }

  private async rollbackToken(api: CloudflareAccessApi, tokenId: string): Promise<void> {
    try {
      await api.deleteServiceToken(tokenId);
    } catch {
      // Recovery is possible through the provisioning request row; never report success.
    }
  }

  private async rollbackPolicyAndToken(
    api: CloudflareAccessApi,
    appId: string,
    policyId: string,
    tokenId: string,
  ): Promise<void> {
    try {
      await api.removeServiceTokenFromPolicy(appId, policyId, tokenId);
    } catch {
      // Best effort; the persisted failed request remains recoverable.
    }
    await this.rollbackToken(api, tokenId);
  }

  private enqueueProvision<T>(task: () => Promise<T>): Promise<T> {
    const next = this.provisionQueue.then(task, task);
    this.provisionQueue = next.catch(() => undefined);
    return next;
  }

  private agentView(row: AgentRow): Agent {
    const socket = this.currentSocket(row);
    const agent = agentFromRow(row, nowMs(), socket);
    const active = this.activeRun(row.id);
    if (active) agent.currentRunId = active.id;
    return agent;
  }

  private async patchAgent(request: Request, id: string): Promise<Response> {
    const row = this.agentRow(id);
    if (!row) return errorResponse("agent not found", 404);
    const body = parseBody(await request.text());
    let name: string | undefined;
    let groupIds: string[] | undefined;
    if (body.name !== undefined) name = asString(body.name, "name", 100);
    if (body.groupIds !== undefined) groupIds = this.validateGroups(body.groupIds);
    if (name === undefined && groupIds === undefined) {
      return errorResponse("no changes supplied", 400);
    }
    if (name !== undefined) {
      this.run(
        "UPDATE agents SET name=?,name_is_manual=1 WHERE id=?",
        name,
        id,
      );
    }
    if (groupIds !== undefined) {
      this.run("UPDATE agents SET group_ids=? WHERE id=?", JSON.stringify(groupIds), id);
    }
    this.notifyAgentsChanged();
    return json({ agent: this.agentView(this.agentRow(id)!) });
  }

  private async disableAgent(id: string): Promise<Response> {
    const row = this.agentRow(id);
    if (!row) return errorResponse("agent not found", 404);
    if (row.disabled === 0) {
      this.run("UPDATE agents SET disabled=1 WHERE id=?", id);
      this.closeAgentSockets(id, 4003, "agent disabled");
      this.failActiveRuns(id, "agent disabled");
      this.notifyAgentsChanged();
    }
    const fresh = this.agentRow(id)!;
    if (!fresh.access_token_id) {
      await this.scheduleAlarm();
      return json({ ok: true });
    }
    // Local disable is already effective. Token cleanup is retriable and must
    // never be reported as successful if Cloudflare refuses the deletion.
    return this.enqueueProvision(async (): Promise<Response> => {
      try {
        const config = provisionConfig(this.env);
        const api = new CloudflareAccessApi(config, this.env);
        await this.removePolicyToken(
          api,
          config.agentAppId,
          config.agentPolicyId,
          fresh.access_token_id!,
        );
        this.run(
          "UPDATE agents SET access_token_id=NULL,token_cipher=NULL WHERE id=?",
          id,
        );
        await this.scheduleAlarm();
        return json({ ok: true });
      } catch (error) {
        if (error instanceof ConfigError) return errorResponse(error.message, 503);
        return errorResponse(
          "agent is disabled locally but Cloudflare token cleanup failed; retry disable",
          502,
        );
      }
    });
  }

  private async rotateAgent(id: string): Promise<Response> {
    const row = this.agentRow(id);
    if (!row) return errorResponse("agent not found", 404);
    if (row.disabled !== 0) return errorResponse("disabled agent cannot be rotated", 409);
    return this.enqueueProvision(async (): Promise<Response> => {
      const config = provisionConfig(this.env);
      const api = new CloudflareAccessApi(config, this.env);
      const current = this.agentRow(id);
      if (!current) return errorResponse("agent not found", 404);
      if (current.disabled !== 0) return errorResponse("disabled agent cannot be rotated", 409);
      if (current.previous_token_id && current.previous_token_id !== current.access_token_id) {
        try {
          await this.removePolicyToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            current.previous_token_id,
          );
          this.run("UPDATE agents SET previous_token_id=NULL WHERE id=?", id);
        } catch {
          return errorResponse("previous rotated token cleanup failed; retry rotate", 502);
        }
      } else if (current.previous_token_id) {
        this.run("UPDATE agents SET previous_token_id=NULL WHERE id=?", id);
      }
      const oldCipher = current.token_cipher;
      const oldTokenId = current.access_token_id;
      const oldClientId = current.access_client_id;
      const rotationMaterial = `${id}:${oldTokenId ?? "none"}`;
      const rotationHash = await sha256Hex(rotationMaterial);
      const tokenName = `ecp-r-${rotationHash.slice(0, 32)}`;
      const intentId = `rot_${rotationHash.slice(0, 32)}`;
      const priorRotateIntent = this.one<ProvisionRequestRow>(
        "SELECT * FROM provision_requests WHERE request_id=?",
        intentId,
      );
      const startedAt = nowMs();
      this.run(
        `INSERT INTO provision_requests(request_id,kind,payload_hash,status,token_name,created_at,updated_at)
         VALUES(?,'rotate',?,'pending',?,?,?)
         ON CONFLICT(request_id) DO UPDATE SET
           status='pending',token_name=excluded.token_name,updated_at=excluded.updated_at`,
        intentId,
        rotationMaterial.slice(0, 300),
        tokenName,
        startedAt,
        startedAt,
      );
      try {
        const token = await this.obtainToken(api, tokenName, "8760h", {
          kind: "rotate",
          appId: config.agentAppId,
          policyId: config.agentPolicyId,
          recoverOrphan: Boolean(priorRotateIntent),
        });
        if (token.id === oldTokenId) {
          this.run(
            "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
            id,
            nowMs(),
            intentId,
          );
          return json({ agent: this.agentView(this.agentRow(id)!) });
        }
        try {
          await api.addServiceTokenToPolicy(config.agentAppId, config.agentPolicyId, token.id);
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
          throw error;
        }
        try {
          const cipher = await encryptSecret(
            JSON.stringify({ clientId: token.client_id, clientSecret: token.client_secret }),
            config.encryptionKey,
          );
          this.run(
            "UPDATE agents SET access_client_id=?,access_token_id=?,previous_token_id=?,token_cipher=?,boot_id=NULL,connection_id=NULL WHERE id=?",
            token.client_id,
            token.id,
            oldTokenId,
            cipher,
            id,
          );
          this.closeAgentSockets(id, 4004, "credentials rotated");
          if (oldTokenId) {
            try {
              await api.removeServiceTokenFromPolicy(
                config.agentAppId,
                config.agentPolicyId,
                oldTokenId,
              );
              await api.deleteServiceToken(oldTokenId);
              this.run("UPDATE agents SET previous_token_id=NULL WHERE id=? AND previous_token_id=?", id, oldTokenId);
            } catch (error) {
              // Restore the old credential envelope so rotation is not reported as successful.
              this.run(
                "UPDATE agents SET access_client_id=?,access_token_id=?,previous_token_id=NULL,token_cipher=?,connection_id=NULL WHERE id=?",
                oldClientId,
                oldTokenId,
                oldCipher,
                id,
              );
              await this.rollbackPolicyAndToken(
                api,
                config.agentAppId,
                config.agentPolicyId,
                token.id,
              );
              throw error;
            }
          }
        } catch (error) {
          throw error;
        }
        this.run(
          "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
          id,
          nowMs(),
          intentId,
        );
        this.notifyAgentsChanged();
        return json({ agent: this.agentView(this.agentRow(id)!) });
      } catch (error) {
        const message =
          error instanceof CloudflareApiError || error instanceof ConfigError
            ? error.message
            : "credential rotation failed";
        this.run(
          "UPDATE provision_requests SET status='failed',error=?,updated_at=? WHERE request_id=?",
          message.slice(0, 300),
          nowMs(),
          intentId,
        );
        throw error;
      }
    });
  }

  private failActiveRuns(agentId: string, reason: string): void {
    const active = this.activeRun(agentId);
    if (!active) return;
    this.run(
      `UPDATE runs SET status='unknown',reason=?,finished_at=?,deadline_at=NULL,accept_deadline=NULL WHERE id=?`,
      reason,
      nowMs(),
      active.id,
    );
    this.run("UPDATE batches SET all_done=1 WHERE id=? AND NOT EXISTS(SELECT 1 FROM runs WHERE batch_id=? AND status NOT IN " + TERMINAL_SQL + ")", active.batch_id, active.batch_id);
    this.notifyChanged(active.batch_id, active.id, active.last_seq);
  }

  private async agentInstallInfo(id: string): Promise<Response> {
    const row = this.agentRow(id);
    if (!row) return errorResponse("agent not found", 404);
    return this.installResponse(row, "direct");
  }

  private async enrollmentInstallInfo(id: string): Promise<Response> {
    const row = this.one<EnrollmentRow>("SELECT * FROM enrollments WHERE id=?", id);
    if (!row) return errorResponse("enrollment not found", 404);
    if (row.revoked !== 0 || row.expires_at <= nowMs()) {
      return errorResponse("enrollment is not active", 410);
    }
    return this.enrollmentInstallResponse(row);
  }

  private async installResponse(row: AgentRow, mode: "direct"): Promise<Response> {
    if (row.disabled !== 0) return errorResponse("agent is disabled", 409);
    if (!row.token_cipher) return errorResponse("agent has no install credential", 409);
    if (!validEncryptionKey(this.env.CREDENTIAL_ENCRYPTION_KEY)) {
      return errorResponse("credential encryption is not configured", 503);
    }
    let creds: { clientId: string; clientSecret: string };
    try {
      creds = JSON.parse(
        await decryptSecret(row.token_cipher, this.env.CREDENTIAL_ENCRYPTION_KEY),
      ) as { clientId: string; clientSecret: string };
    } catch {
      return errorResponse("stored credential cannot be decrypted", 500);
    }
    const script = await this.fetchInstallScript();
    if (!script) return errorResponse("install script is unavailable", 503);
    const info = this.buildInstallInfo(creds, mode, row.id, script);
    return json(info, 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
  }

  private async enrollmentInstallResponse(row: EnrollmentRow): Promise<Response> {
    if (!row.token_cipher) return errorResponse("enrollment has no install credential", 409);
    if (!validEncryptionKey(this.env.CREDENTIAL_ENCRYPTION_KEY)) {
      return errorResponse("credential encryption is not configured", 503);
    }
    let creds: { clientId: string; clientSecret: string };
    try {
      creds = JSON.parse(
        await decryptSecret(row.token_cipher, this.env.CREDENTIAL_ENCRYPTION_KEY),
      ) as { clientId: string; clientSecret: string };
    } catch {
      return errorResponse("stored credential cannot be decrypted", 500);
    }
    const script = await this.fetchInstallScript();
    if (!script) return errorResponse("install script is unavailable", 503);
    const info = this.buildInstallInfo(creds, "enroll", undefined, script);
    return json(info, 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
  }

  private async fetchInstallScript(): Promise<string | null> {
    const base = this.publicUrl();
    if (!base) return null;
    try {
      const response = await this.env.ASSETS.fetch(
        new Request(`${base}/downloads/install.sh`, { headers: { accept: "text/plain" } }),
      );
      if (!response.ok) return null;
      const text = new TextDecoder().decode(await response.arrayBuffer());
      if (!text || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) return null;
      return text;
    } catch {
      return null;
    }
  }

  private buildInstallInfo(
    creds: { clientId: string; clientSecret: string },
    mode: "direct" | "enroll",
    agentId: string | undefined,
    script: string,
  ): InstallInfo {
    const base = this.publicUrl()!;
    const scriptUrl = `${base}/${mode === "direct" ? "agent" : "enroll"}/install.sh`;
    const envs = [
      `ECP_URL=${shellQuote(base)}`,
      `ECP_MODE=${shellQuote(mode)}`,
      `ECP_CLIENT_ID=${shellQuote(creds.clientId)}`,
      `ECP_CLIENT_SECRET=${shellQuote(creds.clientSecret)}`,
    ];
    if (agentId) envs.push(`ECP_AGENT_ID=${shellQuote(agentId)}`);
    // Self-contained script: exported environment followed by the generic installer.
    // The script endpoint itself returns only the generic installer.
    const selfContained =
      `#!/usr/bin/env bash\n` +
      `# Generated by Edge Command Panel. Contains one-time install credentials; do not log.\n` +
      `set -euo pipefail\n` +
      envs.map((line) => `export ${line}\n`).join("") +
      `${script.startsWith("#!") ? script.slice(script.indexOf("\n") + 1) : script}`;
    const inner =
      `set -euo pipefail; t=$(mktemp); trap 'rm -f "$t"' EXIT; ` +
      `curl -fsSL --proto '=https' --tlsv1.2 ` +
      `-H ${shellQuote(`CF-Access-Client-Id: ${creds.clientId}`)} ` +
      `-H ${shellQuote(`CF-Access-Client-Secret: ${creds.clientSecret}`)} ` +
      `-o "$t" ${shellQuote(scriptUrl)}; ` +
      `env ${envs.join(" ")} bash "$t"`;
    const command = `bash -o pipefail -c ${shellQuote(inner)}`;
    const link = `${base}/install#${b64urlEncode(JSON.stringify({ command }))}`;
    return { command, link, script: selfContained };
  }

  private publicUrl(): string | null {
    try {
      return new URL(this.env.PUBLIC_URL).origin;
    } catch {
      return null;
    }
  }

  private async createGroup(request: Request): Promise<Response> {
    const body = parseBody(await request.text());
    const name = asString(body.name, "name", 64);
    const exists = this.one<GroupRow>("SELECT * FROM groups WHERE name=?", name);
    if (exists) return json({ group: exists });
    const id = randomId("gr");
    this.run(
      "INSERT INTO groups(id,name,created_at) VALUES(?,?,?)",
      id,
      name,
      nowMs(),
    );
    return json({ group: { id, name } }, 201);
  }

  private async patchGroup(request: Request, id: string): Promise<Response> {
    const row = this.one<GroupRow>("SELECT * FROM groups WHERE id=?", id);
    if (!row) return errorResponse("group not found", 404);
    const body = parseBody(await request.text());
    const name = asString(body.name, "name", 64);
    const duplicate = this.one<GroupRow>("SELECT * FROM groups WHERE name=? AND id<>?", name, id);
    if (duplicate) return errorResponse("group name already exists", 409);
    this.run("UPDATE groups SET name=? WHERE id=?", name, id);
    return json({ group: { id, name } });
  }

  private async deleteGroup(id: string): Promise<Response> {
    const row = this.one<GroupRow>("SELECT * FROM groups WHERE id=?", id);
    if (!row) return errorResponse("group not found", 404);
    this.ctx.storage.transactionSync(() => {
      this.run("DELETE FROM groups WHERE id=?", id);
      this.removeAgentGroup(id);
      this.removeEnrollmentGroup(id);
    });
    this.notifyAgentsChanged();
    return json({ ok: true });
  }

  private removeAgentGroup(groupId: string): void {
    const rows = this.sql<{ id: string; group_ids: string }>("SELECT id,group_ids FROM agents");
    for (const row of rows) {
      const ids = parseJsonColumn<string[]>(row.group_ids, []).filter((id) => id !== groupId);
      this.run("UPDATE agents SET group_ids=? WHERE id=?", JSON.stringify(ids), row.id);
    }
  }

  private removeEnrollmentGroup(groupId: string): void {
    const rows = this.sql<{ id: string; group_ids: string }>(
      "SELECT id,group_ids FROM enrollments",
    );
    for (const row of rows) {
      const ids = parseJsonColumn<string[]>(row.group_ids, []).filter((id) => id !== groupId);
      this.run("UPDATE enrollments SET group_ids=? WHERE id=?", JSON.stringify(ids), row.id);
    }
  }

  private async createEnrollment(request: Request): Promise<Response> {
    const body = parseBody(await request.text());
    const requestId = asUuid(body.requestId, "requestId");
    const name = asString(body.name, "name", 100);
    const groupIds = this.validateGroups(body.groupIds ?? []);
    const maxAgents = asInt(body.maxAgents, "maxAgents", 1, 50);
    const ttlMinutes = asInt(body.ttlMinutes, "ttlMinutes", 1, 43_200);
    const canonical = canonicalJson({ name, groupIds, maxAgents, ttlMinutes });
    const now = nowMs();
    const existing = this.one<ProvisionRequestRow>(
      "SELECT * FROM provision_requests WHERE request_id=?",
      requestId,
    );
    if (existing) {
      if (existing.kind !== "enrollment" || existing.payload_hash !== canonical) {
        return errorResponse("requestId reused with a different payload", 409);
      }
      if (existing.status === "complete" && existing.result_id) {
        const row = this.one<EnrollmentRow>(
          "SELECT * FROM enrollments WHERE id=?",
          existing.result_id,
        );
        if (row) {
          const install = await this.enrollmentInstallInfo(row.id);
          if (!install.ok) return install;
          return json({ enrollment: enrollmentFromRow(row), install: await install.json() });
        }
      }
      if (existing.status === "pending" && nowMs() - existing.updated_at < 120_000) {
        return errorResponse("provisioning is already in progress", 409);
      }
    }
    if (this.usageFromRow(await this.usageRow()).limited) {
      return errorResponse("project usage limit reached", 507);
    }
    if (!existing) {
      this.run(
        `INSERT INTO provision_requests(request_id,kind,payload_hash,status,token_name,created_at,updated_at)
         VALUES(?,?,?,'pending',?,?,?)`,
        requestId,
        "enrollment",
        canonical,
        `ecp-e-${requestId}`,
        now,
        now,
      );
    } else {
      this.run(
        "UPDATE provision_requests SET status='pending',updated_at=? WHERE request_id=?",
        now,
        requestId,
      );
    }
    try {
      return await this.enqueueProvision(async () => {
        const config = provisionConfig(this.env);
        const api = new CloudflareAccessApi(config, this.env);
        const tokenName = `ecp-e-${requestId}`;
        const token = await this.obtainToken(api, tokenName, `${Math.max(60, ttlMinutes + 60)}m`, {
          kind: "enrollment",
          appId: config.enrollAppId,
          policyId: config.enrollPolicyId,
          recoverOrphan: Boolean(existing),
        });
        const recovered = this.one<EnrollmentRow>(
          "SELECT * FROM enrollments WHERE access_client_id=?",
          token.client_id,
        );
        if (recovered) {
          this.run(
            "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
            recovered.id,
            nowMs(),
            requestId,
          );
          const install = await this.enrollmentInstallResponse(recovered);
          if (!install.ok) return install;
          return json({
            enrollment: enrollmentFromRow(recovered),
            install: await install.json(),
          });
        }
        try {
          await api.addServiceTokenToPolicy(
            config.enrollAppId,
            config.enrollPolicyId,
            token.id,
          );
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.enrollAppId,
            config.enrollPolicyId,
            token.id,
          );
          throw error;
        }
        const enrollmentId = randomId("en");
        const cipher = await encryptSecret(
          JSON.stringify({ clientId: token.client_id, clientSecret: token.client_secret }),
          config.encryptionKey,
        );
        try {
          this.ctx.storage.transactionSync(() => {
            this.run(
              `INSERT INTO enrollments(id,request_id,name,group_ids,max_agents,registered_count,expires_at,revoked,access_client_id,access_token_id,token_cipher,created_at)
               VALUES(?,?,?,?,?,0,?,0,?,?,?,?)`,
              enrollmentId,
              requestId,
              name,
              JSON.stringify(groupIds),
              maxAgents,
              now + ttlMinutes * 60_000,
              token.client_id,
              token.id,
              cipher,
              now,
            );
            this.run(
              "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
              enrollmentId,
              now,
              requestId,
            );
          });
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.enrollAppId,
            config.enrollPolicyId,
            token.id,
          );
          throw error;
        }
        const row = this.one<EnrollmentRow>(
          "SELECT * FROM enrollments WHERE id=?",
          enrollmentId,
        )!;
        const installResponse = await this.enrollmentInstallResponse(row);
        if (!installResponse.ok) return installResponse;
        return json({
          enrollment: enrollmentFromRow(row),
          install: await installResponse.json(),
        });
      });
    } catch (error) {
      const message =
        error instanceof CloudflareApiError || error instanceof ConfigError
          ? error.message
          : "enrollment provisioning failed";
      this.run(
        "UPDATE provision_requests SET status='failed',error=?,updated_at=? WHERE request_id=?",
        message.slice(0, 300),
        nowMs(),
        requestId,
      );
      return errorResponse(message, error instanceof ConfigError ? 503 : 502);
    }
  }

  private async revokeEnrollment(id: string): Promise<Response> {
    const row = this.one<EnrollmentRow>("SELECT * FROM enrollments WHERE id=?", id);
    if (!row) return errorResponse("enrollment not found", 404);
    this.run("UPDATE enrollments SET revoked=1 WHERE id=?", id);
    const tokenId = row.access_token_id;
    if (!tokenId) return json({ ok: true });
    return this.enqueueProvision(async (): Promise<Response> => {
      try {
        const config = provisionConfig(this.env);
        const api = new CloudflareAccessApi(config, this.env);
        await this.removePolicyToken(
          api,
          config.enrollAppId,
          config.enrollPolicyId,
          tokenId,
        );
        this.run(
          "UPDATE enrollments SET access_token_id=NULL,token_cipher=NULL WHERE id=?",
          id,
        );
        return json({ ok: true });
      } catch (error) {
        if (error instanceof ConfigError) return errorResponse(error.message, 503);
        return errorResponse(
          "enrollment is revoked locally but Cloudflare token cleanup failed; retry revoke",
          502,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Batches, runs and events
  // ---------------------------------------------------------------------------

  private async createBatch(request: Request): Promise<Response> {
    const body = parseBody(await request.text());
    const requestId = asUuid(body.requestId, "requestId");
    const agentIds = asStringArray(body.agentIds ?? [], "agentIds");
    const groupIds = asStringArray(body.groupIds ?? [], "groupIds");
    const command = asString(body.command, "command", MAX_COMMAND_BYTES);
    if (!command.trim()) throw new ValidationError("command must not be blank");
    const timeoutSec =
      body.timeoutSec === undefined
        ? DEFAULT_TIMEOUT_SEC
        : asInt(body.timeoutSec, "timeoutSec", 1, MAX_TIMEOUT_SEC);
    if (agentIds.length + groupIds.length === 0) {
      throw new ValidationError("at least one target is required");
    }
    if (agentIds.length > MAX_TARGETS || groupIds.length > MAX_TARGETS) {
      throw new ValidationError("too many targets");
    }
    const canonical = canonicalJson({
      agentIds: sortUnique(agentIds),
      groupIds: sortUnique(groupIds),
      command,
      timeoutSec,
    });
    const prior = this.one<BatchRow>("SELECT * FROM batches WHERE request_id=?", requestId);
    if (prior) {
      if (prior.payload !== canonical) {
        return errorResponse("requestId reused with a different payload", 409);
      }
      return json({
        batch: batchFromRow(prior),
        runs: this.runsForBatch(prior.id),
      });
    }
    const usage = this.usageFromRow(await this.usageRow());
    if (usage.limited) return errorResponse("project usage limit reached", 507);

    const targetAgents = new Map<string, AgentRow>();
    for (const id of agentIds) {
      const row = this.agentRow(id);
      if (!row) return errorResponse(`agent not found: ${id}`, 400);
      targetAgents.set(id, row);
    }
    const resolvedGroups: string[] = [];
    for (const id of groupIds) {
      const group = this.one<GroupRow>("SELECT * FROM groups WHERE id=?", id);
      if (!group) return errorResponse(`group not found: ${id}`, 400);
      resolvedGroups.push(id);
    }
    if (resolvedGroups.length) {
      const allAgents = this.sql<AgentRow>("SELECT * FROM agents");
      for (const row of allAgents) {
        const ids = parseJsonColumn<string[]>(row.group_ids, []);
        if (ids.some((gid) => resolvedGroups.includes(gid))) targetAgents.set(row.id, row);
      }
    }
    const targets = [...targetAgents.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (targets.length < 1 || targets.length > MAX_TARGETS) {
      return errorResponse("resolved target count must be 1..100", 400);
    }
    const now = nowMs();
    const batchId = randomId("bt");
    const active = this.currentRuns();
    const runs: { row: RunRow; dispatch: boolean }[] = [];
    const placeholders = targets.map(() => "?").join(",");
    const activeRows = this.sql<{ agent_id: string }>(
      `SELECT agent_id FROM runs WHERE agent_id IN (${placeholders}) AND status IN ${ACTIVE_SQL}`,
      ...targets.map((a) => a.id),
    );
    const busy = new Set(activeRows.map((r) => r.agent_id));

    for (const agent of targets) {
      let status: RunStatus;
      if (agent.disabled !== 0 || !this.socketOnline(agent)) status = "skipped_offline";
      else if (busy.has(agent.id)) status = "skipped_busy";
      else status = "dispatching";
      runs.push({
        row: {
          id: randomId("rn"),
          batch_id: batchId,
          agent_id: agent.id,
          agent_name: agent.name,
          status,
          last_seq: 0,
          exit_code: null,
          reason: null,
          output_truncated: 0,
          created_at: now,
          accepted_at: null,
          started_at: null,
          deadline_at: null,
          accept_deadline: status === "dispatching" ? now + ACCEPT_WINDOW_MS : null,
          finished_at: status === "dispatching" ? null : now,
          output_bytes: 0,
          timeout_sec: timeoutSec,
        },
        dispatch: status === "dispatching",
      });
    }

    this.ctx.storage.transactionSync(() => {
      this.run(
        "INSERT INTO batches(id,request_id,payload,command,timeout_sec,created_at,all_done) VALUES(?,?,?,?,?,?,?)",
        batchId,
        requestId,
        canonical,
        command,
        timeoutSec,
        now,
        runs.every((r) => !r.dispatch) ? 1 : 0,
      );
      for (const item of runs) {
        const r = item.row;
        this.run(
          `INSERT INTO runs(id,batch_id,agent_id,agent_name,status,last_seq,created_at,accept_deadline,finished_at,timeout_sec)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          r.id,
          r.batch_id,
          r.agent_id,
          r.agent_name,
          r.status,
          r.last_seq,
          r.created_at,
          r.accept_deadline,
          r.finished_at,
          r.timeout_sec,
        );
      }
    });

    for (const item of runs) {
      if (!item.dispatch) continue;
      const agent = targetAgents.get(item.row.agent_id);
      const socket = agent ? this.currentSocket(agent) : undefined;
      if (!socket) {
        this.markUnknown(item.row.id, "dispatch failed: agent offline");
        continue;
      }
      const frame: ServerFrame = {
        v: PROTOCOL_V,
        type: "execute",
        runId: item.row.id,
        command,
        timeoutSec,
        acceptBefore: now + ACCEPT_WINDOW_MS,
      };
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        this.markUnknown(item.row.id, "dispatch failed: send error");
      }
    }
    const batch = this.one<BatchRow>("SELECT * FROM batches WHERE id=?", batchId)!;
    const resultRuns = this.runsForBatch(batchId);
    this.notifyChanged(batchId);
    this.notifyAgentsChanged();
    await this.scheduleAlarm();
    void active;
    return json({ batch: batchFromRow(batch), runs: resultRuns }, 201);
  }

  private markUnknown(runId: string, reason: string): void {
    const row = this.one<RunRow>("SELECT * FROM runs WHERE id=?", runId);
    if (!row || isTerminal(row.status)) return;
    this.run(
      `UPDATE runs SET status='unknown',reason=?,finished_at=?,deadline_at=NULL,accept_deadline=NULL WHERE id=?`,
      reason.slice(0, 1000),
      nowMs(),
      runId,
    );
    this.finalizeBatch(row.batch_id);
    this.notifyChanged(row.batch_id, runId, row.last_seq);
  }

  private finalizeBatch(batchId: string): void {
    this.run(
      `UPDATE batches SET all_done=1 WHERE id=? AND NOT EXISTS(
         SELECT 1 FROM runs WHERE batch_id=? AND status NOT IN ${TERMINAL_SQL}
       )`,
      batchId,
      batchId,
    );
  }

  private runsForBatch(batchId: string): Run[] {
    return this.sql<RunRow>(
      "SELECT * FROM runs WHERE batch_id=? ORDER BY created_at ASC,id ASC",
      batchId,
    ).map(runFromRow);
  }

  private async listBatches(cursorRaw: string | null): Promise<Response> {
    const cursor = parseCursor(cursorRaw);
    if (cursorRaw && !cursor) return errorResponse("invalid cursor", 400);
    let rows: BatchRow[];
    if (cursor) {
      rows = this.sql<BatchRow>(
        `SELECT * FROM batches
         WHERE (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC,id DESC LIMIT ?`,
        cursor.createdAt,
        cursor.createdAt,
        cursor.id,
        CURSOR_LIMIT + 1,
      );
    } else {
      rows = this.sql<BatchRow>(
        "SELECT * FROM batches ORDER BY created_at DESC,id DESC LIMIT ?",
        CURSOR_LIMIT + 1,
      );
    }
    const hasMore = rows.length > CURSOR_LIMIT;
    const page = rows.slice(0, CURSOR_LIMIT);
    const last = page[page.length - 1];
    return json({
      batches: page.map(batchFromRow),
      nextCursor: hasMore && last ? makeCursor(last.created_at, last.id) : null,
    });
  }

  private async getBatch(id: string): Promise<Response> {
    const row = this.one<BatchRow>("SELECT * FROM batches WHERE id=?", id);
    if (!row) return errorResponse("batch not found", 404);
    return json({ batch: batchFromRow(row), runs: this.runsForBatch(id) });
  }

  private async getEvents(runId: string, afterRaw: string | null): Promise<Response> {
    const row = this.one<RunRow>("SELECT * FROM runs WHERE id=?", runId);
    if (!row) return errorResponse("run not found", 404);
    let afterSeq = 0;
    if (afterRaw !== null) {
      if (!/^\d+$/.test(afterRaw)) return errorResponse("afterSeq must be a non-negative integer", 400);
      afterSeq = Number(afterRaw);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        return errorResponse("afterSeq must be a non-negative integer", 400);
      }
    }
    const rows = this.sql<EventRow>(
      `SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT ?`,
      runId,
      afterSeq,
      EVENT_PAGE_LIMIT + 1,
    );
    const hasMore = rows.length > EVENT_PAGE_LIMIT;
    const page = rows.slice(0, EVENT_PAGE_LIMIT);
    const nextSeq = page.length ? page[page.length - 1]!.seq : afterSeq;
    return json({ events: page.map(eventFromRow), nextSeq, hasMore });
  }

  // ---------------------------------------------------------------------------
  // Agent websocket
  // ---------------------------------------------------------------------------

  private async handleAgentSocket(request: Request): Promise<Response> {
    if (this.role(request) !== "agent") return errorResponse("forbidden", 403);
    const clientId = request.headers.get("x-ecp-access-client-id") || "";
    if (!clientId) return errorResponse("missing Access client id", 403);
    const row = this.agentByClientId(clientId);
    if (!row) return errorResponse("agent not registered", 403);
    if (row.disabled !== 0) return errorResponse("agent disabled", 403);
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return errorResponse("websocket upgrade required", 426);
    }
    const expiryRaw = request.headers.get("x-ecp-auth-expiry") || "";
    const expiry = Number(expiryRaw);
    if (!Number.isSafeInteger(expiry) || expiry <= nowMs()) {
      return errorResponse("agent JWT expired", 401);
    }
    const connectionId = crypto.randomUUID();
    const connectedAt = nowMs();
    const authDeadline = Math.min(expiry, connectedAt + BROWSER_WS_MAX_MS);
    const oldSockets = this.ctx.getWebSockets(row.id);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: AgentAttachment = {
      kind: "agent",
      agentId: row.id,
      connectionId,
      hello: false,
      connectedAt,
      lastSeenAt: connectedAt,
      authDeadline,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [row.id]);
    this.run(
      "UPDATE agents SET connection_id=?,connected_at=? WHERE id=?",
      connectionId,
      connectedAt,
      row.id,
    );
    for (const old of oldSockets) {
      const a = attachmentAgent(old);
      if (a && a.connectionId !== connectionId) {
        this.closeAgent(old, 4001, "replaced by new connection");
      }
    }
    this.send(server, { v: PROTOCOL_V, type: "welcome", connectionId });
    this.notifyAgentsChanged();
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, frame: ServerFrame): boolean {
    const a = readAttachment(ws);
    if (socketClosing(ws, a)) return false;
    if (a?.kind === "agent" && a.authDeadline <= nowMs()) {
      this.closeAgent(ws, 4003, "reauth required");
      return false;
    }
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private updateAttachment(ws: WebSocket, patch: Partial<AgentAttachment>): void {
    const current = readAttachment(ws);
    if (!current || current.kind !== "agent") return;
    ws.serializeAttachment({ ...current, ...patch, lastSeenAt: patch.lastSeenAt ?? nowMs() });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.usageDelta.requests += 1;
    try {
      const attachment = readAttachment(ws);
      if (!attachment || socketClosing(ws, attachment)) return;
      if (attachment.kind === "browser") {
        // Browser sockets are notify-only. Text "ping" is handled by auto-response.
        return;
      }
      const current = this.agentRow(attachment.agentId);
      if (
        !current ||
        current.disabled !== 0 ||
        current.connection_id !== attachment.connectionId
      ) {
        return;
      }
      if (attachment.authDeadline <= nowMs()) {
        this.closeAgent(ws, 4003, "reauth required");
        return;
      }
      if (typeof message !== "string") {
        this.closeAgent(ws, 1003, "text frames only");
        return;
      }
      const byteLength = encoder.encode(message).byteLength;
      if (byteLength > MAX_FRAME_BYTES) {
        this.closeAgent(ws, 1009, "frame too large");
        return;
      }
      if (message === "ping") {
        try {
          ws.send("pong");
        } catch {
          // auto-response normally handles this; no persistent state changes.
        }
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        this.closeAgent(ws, 1008, "invalid JSON");
        return;
      }
      if (!isRecord(frame) || frame.v !== 1 || typeof frame.type !== "string") {
        this.closeAgent(ws, 1008, "invalid frame");
        return;
      }
      this.updateAttachment(ws, {});
      if (frame.type === "hello") {
        await this.handleHello(ws, current, frame as unknown as AgentFrame, attachment);
        return;
      }
      if (frame.type === "event") {
        if (!attachment.hello) {
          this.closeAgent(ws, 1008, "hello required");
          return;
        }
        await this.handleAgentEvent(ws, current, frame as unknown as AgentFrame, attachment);
        return;
      }
      if (frame.type === "probe_reply") {
        this.handleProbeReply(ws, frame as unknown as AgentFrame, attachment);
        return;
      }
      this.closeAgent(ws, 1008, "unknown frame type");
    } catch (error) {
      if (error instanceof ValidationError) {
        this.closeAgent(ws, 1008, error.message.slice(0, 120));
      } else {
        this.closeAgent(ws, 1011, "internal error");
      }
    } finally {
      await this.scheduleAlarm();
      await this.flushUsage();
    }
  }

  private async handleHello(
    ws: WebSocket,
    row: AgentRow,
    frame: AgentFrame,
    attachment: AgentAttachment,
  ): Promise<void> {
    if (frame.type !== "hello") return;
    const bootId = asString(frame.bootId, "bootId", 128);
    const version = asString(frame.version, "version", 64);
    const hostname = asString(frame.hostname, "hostname", 255);
    if (frame.runs !== undefined && !Array.isArray(frame.runs)) {
      throw new ValidationError("runs must be an array");
    }
    const runs = Array.isArray(frame.runs) ? frame.runs : [];
    if (runs.length > 100) throw new ValidationError("too many runs");
    for (const item of runs) {
      if (!isRecord(item)) throw new ValidationError("invalid run report");
      asString(item.runId, "runId", 128);
      asString(item.state, "state", 32);
      asInt(item.lastSeq, "lastSeq", 0, Number.MAX_SAFE_INTEGER);
    }
    const now = nowMs();
    this.updateAttachment(ws, { hello: true, lastSeenAt: now });
    this.run(
      `UPDATE agents SET boot_id=?,version=?,hostname=?,last_hello_at=?,name=CASE
         WHEN name_is_manual=0 THEN ? ELSE name END WHERE id=?`,
      bootId,
      version,
      hostname,
      now,
      hostname,
      row.id,
    );
    // Hello is a supplementary report only. A dispatching run may move to accepted
    // because the agent demonstrably received it, but it is never re-sent and the
    // original acceptBefore is never refreshed.
    for (const item of runs) {
      const report = item as { runId: string; state: string; lastSeq: number };
      const run = this.one<RunRow>("SELECT * FROM runs WHERE id=?", report.runId);
      if (!run || run.agent_id !== row.id) continue;
      if (report.state === "accepted" && run.status === "dispatching") {
        this.run(
          `UPDATE runs SET status='accepted',accepted_at=?,
             deadline_at=COALESCE(deadline_at,?) WHERE id=? AND status='dispatching'`,
          now,
          now + runTimeout(run) + GRACE_MS,
          run.id,
        );
      } else if (report.state === "running" && (run.status === "dispatching" || run.status === "accepted")) {
        this.run(
          `UPDATE runs SET status='running',started_at=COALESCE(started_at,?),
             deadline_at=COALESCE(deadline_at,?) WHERE id=? AND status IN ('dispatching','accepted')`,
          now,
          now + runTimeout(run) + GRACE_MS,
          run.id,
        );
      }
      this.send(ws, {
        v: PROTOCOL_V,
        type: "ack",
        runId: run.id,
        throughSeq: run.last_seq,
      });
    }
    // ACK all other active runs too; server persisted sequence remains authoritative.
    const active = this.sql<RunRow>(
      `SELECT * FROM runs WHERE agent_id=? AND status IN ${ACTIVE_SQL}`,
      row.id,
    );
    for (const run of active) {
      if (!runs.some((r) => (r as { runId?: unknown }).runId === run.id)) {
        this.send(ws, {
          v: PROTOCOL_V,
          type: "ack",
          runId: run.id,
          throughSeq: run.last_seq,
        });
      }
    }
    this.notifyAgentsChanged();
    void attachment;
  }

  private async handleAgentEvent(
    ws: WebSocket,
    row: AgentRow,
    frame: AgentFrame,
    attachment: AgentAttachment,
  ): Promise<void> {
    if (frame.type !== "event") return;
    const runId = asString(frame.runId, "runId", 128);
    const seq = asInt(frame.seq, "seq", 1, Number.MAX_SAFE_INTEGER);
    const kind = frame.kind;
    if (!["accepted", "started", "output", "finished"].includes(kind)) {
      throw new ValidationError("invalid event kind");
    }
    const run = this.one<RunRow>("SELECT * FROM runs WHERE id=?", runId);
    if (!run || run.agent_id !== row.id || row.connection_id !== attachment.connectionId) {
      this.closeAgent(ws, 1008, "event does not belong to this agent");
      return;
    }
    if (seq <= run.last_seq) {
      this.send(ws, { v: PROTOCOL_V, type: "ack", runId, throughSeq: run.last_seq });
      return;
    }
    if (seq !== run.last_seq + 1) {
      this.send(ws, { v: PROTOCOL_V, type: "ack", runId, throughSeq: run.last_seq });
      return;
    }
    if (isTerminal(run.status) && run.status !== "unknown") {
      this.send(ws, { v: PROTOCOL_V, type: "ack", runId, throughSeq: run.last_seq });
      return;
    }

    let stream: EventStream | null = null;
    let data: string | null = null;
    let status: FinishedStatus | null = null;
    let exitCode: number | null = null;
    let reason: string | null = null;
    let outputTruncated = false;
    let storedBytes = 0;

    if (kind === "output") {
      if (frame.stream !== "stdout" && frame.stream !== "stderr") {
        throw new ValidationError("output stream must be stdout or stderr");
      }
      stream = frame.stream;
      if (typeof frame.dataBase64 !== "string") {
        throw new ValidationError("output dataBase64 must be a string");
      }
      if (frame.dataBase64 !== "" && !isStrictBase64(frame.dataBase64)) {
        throw new ValidationError("output dataBase64 is invalid");
      }
      const bytes = frame.dataBase64 === "" ? new Uint8Array() : b64Decode(frame.dataBase64);
      const usage = await this.usageRow();
      const limits = this.limits();
      const dbSize = this.ctx.storage.sql.databaseSize;
      // Keep a reserve so terminal state can still be persisted after output pauses.
      const writeReserve = 500;
      const writeLimited = usage.rows_written >= Math.max(0, limits.rowsWritten - writeReserve);
      const storageLimited = dbSize >= Math.max(0, limits.storageBytes - 1024 * 1024);
      const logLimited = usage.log_frames >= limits.logFrames;
      if (logLimited || writeLimited || storageLimited) {
        // Do not persist, do not ACK: the agent keeps the event pending and may
        // replay after the quota window resets. The run will go unknown at its
        // deadline if the agent cannot finish. No over-budget data is written.
        const retryAfter = Math.max(1000, nextUtcDay() - nowMs());
        this.send(ws, { v: PROTOCOL_V, type: "pause", retryAfter });
        return;
      }
      const runRoom = RUN_OUTPUT_LIMIT_BYTES - run.output_bytes;
      const globalRoom = TOTAL_STORAGE_LIMIT_BYTES - dbSize;
      const allowed = Math.max(0, Math.min(bytes.byteLength, runRoom, globalRoom));
      if (allowed < bytes.byteLength) outputTruncated = true;
      const take = allowed > 0 ? bytes.subarray(0, allowed) : new Uint8Array();
      data = take.byteLength ? b64Encode(take) : null;
      storedBytes = take.byteLength;
      if (frame.outputTruncated === true) outputTruncated = true;
      this.usageDelta.logFrames += 1;
    } else if (kind === "finished") {
      if (
        frame.status !== "succeeded" &&
        frame.status !== "failed" &&
        frame.status !== "timed_out" &&
        frame.status !== "interrupted"
      ) {
        throw new ValidationError("finished status is invalid");
      }
      status = frame.status;
      if (frame.exitCode !== undefined) {
        exitCode = asInt(frame.exitCode, "exitCode", -2_147_483_648, 2_147_483_647);
      }
      if (frame.reason !== undefined) reason = asString(frame.reason, "reason", 1000, 0);
      if (frame.outputTruncated !== undefined) {
        outputTruncated = asBoolean(frame.outputTruncated, "outputTruncated");
      }
    } else if (kind === "accepted" || kind === "started") {
      if (frame.stream !== undefined || frame.dataBase64 !== undefined || frame.status !== undefined) {
        throw new ValidationError("invalid fields for event kind");
      }
    }

    const now = nowMs();
    const storeData = data;
    this.ctx.storage.transactionSync(() => {
      this.run(
        `INSERT INTO run_events(run_id,seq,kind,stream,data,status,exit_code,reason,output_truncated,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        runId,
        seq,
        kind,
        stream,
        storeData,
        status,
        exitCode,
        reason,
        outputTruncated ? 1 : 0,
        now,
      );
      this.run("UPDATE runs SET last_seq=? WHERE id=?", seq, runId);
      if (kind === "output") {
        this.run(
          "UPDATE runs SET output_bytes=output_bytes+?, output_truncated=CASE WHEN ?=1 THEN 1 ELSE output_truncated END WHERE id=?",
          storedBytes,
          outputTruncated ? 1 : 0,
          runId,
        );
      }
      if (kind === "accepted") {
        this.run(
          `UPDATE runs SET status=CASE WHEN status='dispatching' THEN 'accepted' ELSE status END,
             accepted_at=COALESCE(accepted_at,?),
             deadline_at=COALESCE(deadline_at,?) WHERE id=?`,
          now,
          now + runTimeout(run) + GRACE_MS,
          runId,
        );
      } else if (kind === "started") {
        this.run(
          `UPDATE runs SET status=CASE WHEN status IN ('dispatching','accepted') THEN 'running' ELSE status END,
             started_at=COALESCE(started_at,?), deadline_at=COALESCE(deadline_at,?) WHERE id=?`,
          now,
          now + runTimeout(run) + GRACE_MS,
          runId,
        );
      } else if (kind === "output") {
        this.run(
          `UPDATE runs SET status=CASE WHEN status IN ('dispatching','accepted') THEN 'running' ELSE status END,
             started_at=COALESCE(started_at,?), deadline_at=COALESCE(deadline_at,?) WHERE id=?`,
          now,
          now + runTimeout(run) + GRACE_MS,
          runId,
        );
      } else if (kind === "finished" && status) {
        this.run(
          "UPDATE runs SET status=?,exit_code=?,reason=?,output_truncated=CASE WHEN ?=1 THEN 1 ELSE output_truncated END,finished_at=?,deadline_at=NULL,accept_deadline=NULL WHERE id=?",
          status,
          exitCode,
          reason,
          outputTruncated ? 1 : 0,
          now,
          runId,
        );
      }
    });
    if (kind === "finished") {
      this.finalizeBatch(run.batch_id);
      this.notifyAgentsChanged();
    }
    this.notifyChanged(run.batch_id, runId, seq);
    this.send(ws, { v: PROTOCOL_V, type: "ack", runId, throughSeq: seq });
  }

  private handleProbeReply(
    ws: WebSocket,
    frame: AgentFrame,
    attachment: AgentAttachment,
  ): void {
    if (frame.type !== "probe_reply") return;
    const probeId = asString(frame.probeId, "probeId", 100);
    if (!attachment.probeId || attachment.probeId !== probeId || !attachment.probeSentAt) {
      return;
    }
    const now = nowMs();
    this.updateAttachment(ws, {
      latencyMs: Math.max(0, now - attachment.probeSentAt),
      latencyMeasuredAt: now,
      probeId: undefined,
      probeSentAt: undefined,
    });
    this.notifyAgentsChanged();
  }

  private closeAgent(ws: WebSocket, code: number, reason: string): void {
    const attachment = readAttachment(ws);
    if (attachment?.closing) return;
    if (attachment) {
      try {
        ws.serializeAttachment({ ...attachment, closing: true });
      } catch {
        // The socket is already gone; never retry the close below.
      }
    }
    if (!socketOpen(ws)) return;
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private closeAgentSockets(agentId: string, code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets(agentId)) {
      const a = attachmentAgent(ws);
      if (a && !socketClosing(ws, a)) this.closeAgent(ws, code, reason);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    this.usageDelta.requests += 1;
    try {
      const attachment = readAttachment(ws);
      if (attachment && !attachment.closing) {
        try {
          ws.serializeAttachment({ ...attachment, closing: true });
        } catch {
          // The socket is already gone.
        }
      }
      if (attachment?.kind === "agent") {
        const row = this.agentRow(attachment.agentId);
        if (row && row.connection_id === attachment.connectionId) {
          this.run(
            "UPDATE agents SET connection_id=NULL,connected_at=NULL WHERE id=?",
            row.id,
          );
          this.notifyAgentsChanged();
        }
      }
      // Both agent and browser close callbacks must recompute the alarm.
      await this.scheduleAlarm();
      void code;
      void reason;
      void wasClean;
    } finally {
      await this.flushUsage();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void error;
    await this.webSocketClose(ws, 1006, "error", false);
  }

  // ---------------------------------------------------------------------------
  // Browser notifications
  // ---------------------------------------------------------------------------

  private async handleBrowserSocket(request: Request): Promise<Response> {
    if (this.role(request) !== "ui") return errorResponse("forbidden", 403);
    const expiryRaw = request.headers.get("x-ecp-auth-expiry") || "";
    const expiry = Number(expiryRaw);
    if (!Number.isSafeInteger(expiry) || expiry <= nowMs()) {
      return errorResponse("browser JWT expired", 401);
    }
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return errorResponse("websocket upgrade required", 426);
    }
    const expiresAt = Math.min(expiry, nowMs() + BROWSER_WS_MAX_MS);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: BrowserAttachment = {
      kind: "browser",
      expiresAt,
      identity: request.headers.get("x-ecp-identity") || "",
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["browser"]);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private notify(frame: BrowserFrame): void {
    const text = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets("browser")) {
      const a = readAttachment(ws);
      if (!a || a.kind !== "browser" || socketClosing(ws, a)) continue;
      if (a.expiresAt <= nowMs()) {
        this.closeAgent(ws, 4003, "reauth required");
        continue;
      }
      try {
        ws.send(text);
      } catch {
        // A dead browser socket is cleaned by its close handler.
      }
    }
  }

  private notifyChanged(batchId?: string, runId?: string, lastSeq?: number): void {
    const frame: BrowserFrame = { v: PROTOCOL_V, type: "changed" };
    if (batchId) frame.batchId = batchId;
    if (runId) frame.runId = runId;
    if (lastSeq !== undefined) frame.lastSeq = lastSeq;
    this.notify(frame);
  }

  private notifyAgentsChanged(): void {
    this.notify({ v: PROTOCOL_V, type: "agents_changed" });
  }

  // ---------------------------------------------------------------------------
  // Probe
  // ---------------------------------------------------------------------------

  private async handleProbe(request: Request): Promise<Response> {
    const body = parseBody(await request.text());
    const ids = asStringArray(body.agentIds, "agentIds", 100);
    if (ids.length === 0) return errorResponse("agentIds must not be empty", 400);
    const now = nowMs();
    for (const id of ids) {
      const row = this.agentRow(id);
      if (!row) continue;
      const socket = this.currentSocket(row);
      if (!socket) continue;
      const attachment = attachmentAgent(socket);
      if (!attachment) continue;
      if (attachment.lastProbeAt && now - attachment.lastProbeAt < PROBE_MERGE_MS) continue;
      const probeId = crypto.randomUUID();
      this.updateAttachment(socket, { probeId, probeSentAt: now, lastProbeAt: now });
      this.send(socket, { v: PROTOCOL_V, type: "probe", probeId });
    }
    return json({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // Alarm: deadlines, browser re-auth, daily cleanup. No timer loop.
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    this.usageDelta.requests += 1;
    try {
      const now = nowMs();
      const active = this.sql<RunRow>(
        `SELECT * FROM runs WHERE status IN ${ACTIVE_SQL}`,
      );
      for (const run of active) {
        const deadline =
          run.status === "dispatching"
            ? (run.accept_deadline ?? now)
            : (run.deadline_at ?? now);
        if (deadline + GRACE_MS <= now) {
          this.markUnknown(
            run.id,
            run.status === "dispatching" ? "accept timeout" : "run deadline exceeded",
          );
        }
      }
      for (const ws of this.ctx.getWebSockets("browser")) {
        const a = readAttachment(ws);
        if (!a || a.kind !== "browser" || socketClosing(ws, a)) continue;
        if (a.expiresAt <= now) {
          this.closeAgent(ws, 4003, "reauth required");
        }
      }
      for (const ws of this.ctx.getWebSockets()) {
        const a = attachmentAgent(ws);
        if (!a || socketClosing(ws, a)) continue;
        if (a.authDeadline <= now) {
          this.closeAgent(ws, 4003, "reauth required");
        } else if (!a.hello && a.connectedAt + HELLO_TIMEOUT_MS <= now) {
          this.closeAgent(ws, 4008, "hello timeout");
        }
      }
      const meta = this.one<{ value: string }>("SELECT value FROM meta WHERE key='next_cleanup_at'");
      const nextCleanup = Number(meta?.value ?? 0);
      if (!Number.isFinite(nextCleanup) || nextCleanup <= now) {
        this.cleanup(now);
        await this.enqueueProvision(() => this.cleanupRetiredTokens());
        this.run(
          "UPDATE meta SET value=? WHERE key='next_cleanup_at'",
          String(nextCleanupAt(now + DAY_MS)),
        );
      }
      await this.scheduleAlarm();
    } finally {
      await this.flushUsage();
    }
  }

  private cleanup(now: number): void {
    const cutoff = now - RETENTION_MS;
    this.ctx.storage.transactionSync(() => {
      this.run(
        `DELETE FROM run_events WHERE run_id IN (
           SELECT r.id FROM runs r JOIN batches b ON b.id=r.batch_id
           WHERE b.all_done=1 AND b.created_at<?
         )`,
        cutoff,
      );
      this.run(
        `DELETE FROM runs WHERE batch_id IN (
           SELECT id FROM batches WHERE all_done=1 AND created_at<?
         )`,
        cutoff,
      );
      this.run("DELETE FROM batches WHERE all_done=1 AND created_at<?", cutoff);
      this.run("DELETE FROM enrollment_challenges WHERE expires_at<?", now - DAY_MS);
      this.run("DELETE FROM usage WHERE day<?", utcDay(now - 30 * DAY_MS));
    });
  }

  private async scheduleAlarm(): Promise<void> {
    let earliest: number | null = null;
    const consider = (value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      earliest = earliest === null ? value : Math.min(earliest, value);
    };
    const runs = this.sql<RunRow>(
      `SELECT id,status,accept_deadline,deadline_at FROM runs WHERE status IN ${ACTIVE_SQL}`,
    );
    for (const run of runs) {
      const deadline =
        (run.status === "dispatching" ? run.accept_deadline : run.deadline_at) ?? undefined;
      consider(deadline === undefined ? undefined : deadline + GRACE_MS);
    }
    for (const ws of this.ctx.getWebSockets("browser")) {
      const a = readAttachment(ws);
      if (!a || a.kind !== "browser" || socketClosing(ws, a)) continue;
      consider(a.expiresAt);
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentAgent(ws);
      if (!a || socketClosing(ws, a)) continue;
      consider(a.authDeadline);
      if (!a.hello) consider(a.connectedAt + HELLO_TIMEOUT_MS);
    }
    const meta = this.one<{ value: string }>("SELECT value FROM meta WHERE key='next_cleanup_at'");
    const nextCleanup = Number(meta?.value ?? 0);
    if (Number.isFinite(nextCleanup) && nextCleanup > 0) consider(nextCleanup);

    if (earliest === null) {
      const current = await this.ctx.storage.getAlarm();
      if (current !== null) {
        await this.ctx.storage.deleteAlarm();
        this.usageDelta.writes += 1;
      }
      return;
    }
    const target = Math.max(Date.now() + 1, earliest);
    const current = await this.ctx.storage.getAlarm();
    if (current !== target) {
      await this.ctx.storage.setAlarm(target);
      this.usageDelta.writes += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------

  private async handleEnroll(request: Request, path: string): Promise<Response> {
    if (this.role(request) !== "enroll") return errorResponse("forbidden", 403);
    const clientId = request.headers.get("x-ecp-access-client-id") || "";
    if (!clientId) return errorResponse("missing Access client id", 403);
    const enrollment = this.enrollmentByClientId(clientId);
    if (!enrollment) return errorResponse("enrollment not registered", 403);
    if (enrollment.revoked !== 0) return errorResponse("enrollment revoked", 410);
    if (enrollment.expires_at <= nowMs()) return errorResponse("enrollment expired", 410);
    if (path === "/internal/enroll/challenge" && request.method === "POST") {
      return this.enrollChallenge(request, enrollment);
    }
    if (path === "/internal/enroll/register" && request.method === "POST") {
      return this.enrollRegister(request, enrollment);
    }
    if (path === "/internal/enroll/install.sh" && request.method === "GET") {
      return this.handleInstallScript(request);
    }
    if (path.startsWith("/internal/enroll/download/") && request.method === "GET") {
      return this.handleDownload(request, path.slice("/internal/enroll/download/".length));
    }
    return errorResponse("not found", 404);
  }

  private async enrollChallenge(
    request: Request,
    enrollment: EnrollmentRow,
  ): Promise<Response> {
    const body = parseBody(await request.text());
    const installationId = asString(body.installationId, "installationId", 200);
    const publicKey = asString(body.publicKey, "publicKey", 100);
    if (!isStrictBase64(publicKey) || b64Decode(publicKey).byteLength !== 32) {
      return errorResponse("publicKey must be base64 raw Ed25519 32 bytes", 400);
    }
    const challenge = randomToken(32);
    const now = nowMs();
    this.run(
      `INSERT INTO enrollment_challenges(challenge,enrollment_id,installation_id,public_key,expires_at,used,created_at)
       VALUES(?,?,?,?,?,0,?)`,
      challenge,
      enrollment.id,
      installationId,
      publicKey,
      now + ENROLL_CHALLENGE_MS,
      now,
    );
    return json({ challenge, expiresAt: now + ENROLL_CHALLENGE_MS });
  }

  private async enrollRegister(
    request: Request,
    enrollment: EnrollmentRow,
  ): Promise<Response> {
    const body = parseBody(await request.text());
    const installationId = asString(body.installationId, "installationId", 200);
    const hostname = asString(body.hostname, "hostname", 255);
    const publicKey = asString(body.publicKey, "publicKey", 100);
    const challenge = asString(body.challenge, "challenge", 128);
    const signature = asString(body.signature, "signature", 256);
    if (!isStrictBase64(publicKey) || b64Decode(publicKey).byteLength !== 32) {
      return errorResponse("publicKey must be base64 raw Ed25519 32 bytes", 400);
    }
    if (!isStrictBase64(signature) || b64Decode(signature).byteLength !== 64) {
      return errorResponse("signature must be base64 Ed25519 64 bytes", 400);
    }
    const canonical = ["ECP-ENROLL-V1", challenge, installationId, hostname, publicKey].join("\n");
    const valid = await verifyEd25519(
      b64Decode(publicKey),
      b64Decode(signature),
      encoder.encode(canonical),
    );
    if (!valid) return errorResponse("invalid enrollment signature", 403);

    // Re-read every mutable constraint inside the serialized provisioning queue.
    // A request may have waited behind another registration or a provisioning call.
    return this.enqueueProvision(async (): Promise<Response> => {
      const now = nowMs();
      const fresh = this.one<EnrollmentRow>(
        "SELECT * FROM enrollments WHERE id=?",
        enrollment.id,
      );
      if (!fresh || fresh.revoked !== 0) {
        return errorResponse("enrollment revoked", 410);
      }
      if (fresh.expires_at <= now) return errorResponse("enrollment expired", 410);
      const challengeRow = this.one<{
        challenge: string;
        enrollment_id: string;
        installation_id: string;
        public_key: string;
        expires_at: number;
        used: number;
      }>("SELECT * FROM enrollment_challenges WHERE challenge=?", challenge);
      if (
        !challengeRow ||
        challengeRow.used !== 0 ||
        challengeRow.enrollment_id !== fresh.id ||
        challengeRow.installation_id !== installationId ||
        challengeRow.public_key !== publicKey ||
        challengeRow.expires_at < now
      ) {
        return errorResponse("challenge is invalid, expired or already used", 400);
      }

      const existing = this.one<AgentRow>(
        "SELECT * FROM agents WHERE installation_id=?",
        installationId,
      );
      if (existing) {
        if (existing.public_key !== publicKey) {
          return errorResponse("installation id is already bound to another public key", 409);
        }
        if (existing.disabled !== 0) {
          return errorResponse("installation id belongs to a disabled agent", 409);
        }
        const creds = await this.decryptAgentCreds(existing);
        if (!creds) return errorResponse("stored credential unavailable", 500);
        const consumed = this.sql<{ challenge: string }>(
          "UPDATE enrollment_challenges SET used=1 WHERE challenge=? AND used=0 AND expires_at>=? RETURNING challenge",
          challenge,
          now,
        );
        if (consumed.length !== 1) {
          return errorResponse("challenge is invalid, expired or already used", 400);
        }
        return json({
          agentId: existing.id,
          url: this.agentWsUrl(),
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        });
      }
      if (fresh.registered_count >= fresh.max_agents) {
        return errorResponse("enrollment registration limit reached", 409);
      }
      if (this.usageFromRow(await this.usageRow()).limited) {
        return errorResponse("project usage limit reached", 507);
      }

      const config = provisionConfig(this.env);
      const api = new CloudflareAccessApi(config, this.env);
      const registrationHash = await sha256Hex(`${fresh.id}:${installationId}`);
      const tokenName = `ecp-n-${registrationHash.slice(0, 32)}`;
      const intentId = `reg_${registrationHash.slice(0, 32)}`;
      const priorRegistrationIntent = this.one<ProvisionRequestRow>(
        "SELECT * FROM provision_requests WHERE request_id=?",
        intentId,
      );
      const intentNow = nowMs();
      this.run(
        `INSERT INTO provision_requests(request_id,kind,payload_hash,status,token_name,created_at,updated_at)
         VALUES(?,'registration',?,'pending',?,?,?)
         ON CONFLICT(request_id) DO UPDATE SET
           status='pending',token_name=excluded.token_name,updated_at=excluded.updated_at`,
        intentId,
        `${installationId}:${publicKey}`.slice(0, 300),
        tokenName,
        intentNow,
        intentNow,
      );
      try {
        const token = await this.obtainToken(api, tokenName, "8760h", {
          kind: "registration",
          appId: config.agentAppId,
          policyId: config.agentPolicyId,
          recoverOrphan: Boolean(priorRegistrationIntent),
        });
        try {
          await api.addServiceTokenToPolicy(
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
          throw error;
        }
        const agentId = randomId("ag");
        const cipher = await encryptSecret(
          JSON.stringify({ clientId: token.client_id, clientSecret: token.client_secret }),
          config.encryptionKey,
        );
        const groupIds = parseJsonColumn<string[]>(fresh.group_ids, []);
        const txNow = nowMs();
        try {
          this.ctx.storage.transactionSync(() => {
            const consumed = this.sql<{ challenge: string }>(
              "UPDATE enrollment_challenges SET used=1 WHERE challenge=? AND used=0 AND expires_at>=? RETURNING challenge",
              challenge,
              txNow,
            );
            if (consumed.length !== 1) {
              throw new AccessInternalError("challenge is invalid, expired or already used", 400);
            }
            const incremented = this.sql<{ registered_count: number }>(
              `UPDATE enrollments SET registered_count=registered_count+1
               WHERE id=? AND revoked=0 AND expires_at>=? AND registered_count<max_agents
               RETURNING registered_count`,
              fresh.id,
              txNow,
            );
            if (incremented.length !== 1) {
              throw new AccessInternalError("enrollment registration limit reached", 409);
            }
            this.run(
              `INSERT INTO agents(id,name,name_is_manual,hostname,group_ids,disabled,access_client_id,access_token_id,token_cipher,installation_id,public_key,created_at)
               VALUES(?,?,1,?,?,0,?,?,?,?,?,?)`,
              agentId,
              hostname,
              hostname,
              JSON.stringify(groupIds),
              token.client_id,
              token.id,
              cipher,
              installationId,
              publicKey,
              txNow,
            );
            this.run(
              "UPDATE provision_requests SET status='complete',result_id=?,error=NULL,updated_at=? WHERE request_id=?",
              agentId,
              txNow,
              intentId,
            );
          });
        } catch (error) {
          await this.rollbackPolicyAndToken(
            api,
            config.agentAppId,
            config.agentPolicyId,
            token.id,
          );
          throw error;
        }
        this.notifyAgentsChanged();
        return json({
          agentId,
          url: this.agentWsUrl(),
          clientId: token.client_id,
          clientSecret: token.client_secret,
        });
      } catch (error) {
        const message =
          error instanceof CloudflareApiError || error instanceof ConfigError
            ? error.message
            : "enrollment registration failed";
        this.run(
          "UPDATE provision_requests SET status='failed',error=?,updated_at=? WHERE request_id=?",
          message.slice(0, 300),
          nowMs(),
          intentId,
        );
        throw error;
      }
    });
  }

  private async removePolicyToken(
    api: CloudflareAccessApi,
    appId: string,
    policyId: string,
    tokenId: string,
  ): Promise<void> {
    await api.removeServiceTokenFromPolicy(appId, policyId, tokenId);
    try {
      await api.deleteServiceToken(tokenId);
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
  }

  private async cleanupRetiredTokens(): Promise<void> {
    let config;
    try {
      config = provisionConfig(this.env);
    } catch {
      return;
    }
    const api = new CloudflareAccessApi(config, this.env);
    const now = nowMs();
    const enrollments = this.sql<EnrollmentRow>(
      `SELECT * FROM enrollments
       WHERE access_token_id IS NOT NULL AND (revoked=1 OR expires_at<?)
       ORDER BY created_at ASC LIMIT 3`,
      now,
    );
    for (const enrollment of enrollments) {
      try {
        await this.removePolicyToken(
          api,
          config.enrollAppId,
          config.enrollPolicyId,
          enrollment.access_token_id!,
        );
        this.run(
          "UPDATE enrollments SET access_token_id=NULL,token_cipher=NULL WHERE id=?",
          enrollment.id,
        );
      } catch {
        // Retried on the next daily cleanup; local revoked/expired state still blocks use.
      }
    }
    const previousAgents = this.sql<AgentRow>(
      `SELECT * FROM agents WHERE previous_token_id IS NOT NULL ORDER BY created_at ASC LIMIT 3`,
    );
    for (const agent of previousAgents) {
      const previous = agent.previous_token_id!;
      if (previous === agent.access_token_id) {
        this.run("UPDATE agents SET previous_token_id=NULL WHERE id=?", agent.id);
        continue;
      }
      try {
        await this.removePolicyToken(
          api,
          config.agentAppId,
          config.agentPolicyId,
          previous,
        );
        this.run(
          "UPDATE agents SET previous_token_id=NULL WHERE id=? AND previous_token_id=?",
          agent.id,
          previous,
        );
      } catch {
        // Retry on the next daily cleanup.
      }
    }
    const agents = this.sql<AgentRow>(
      `SELECT * FROM agents WHERE disabled=1 AND access_token_id IS NOT NULL
       ORDER BY created_at ASC LIMIT 3`,
    );
    for (const agent of agents) {
      try {
        await this.removePolicyToken(
          api,
          config.agentAppId,
          config.agentPolicyId,
          agent.access_token_id!,
        );
        this.run(
          "UPDATE agents SET access_token_id=NULL,token_cipher=NULL WHERE id=?",
          agent.id,
        );
      } catch {
        // Retried later; disabled is already locally enforced.
      }
    }
  }

  private async decryptAgentCreds(
    row: AgentRow,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    if (!row.token_cipher || !validEncryptionKey(this.env.CREDENTIAL_ENCRYPTION_KEY)) return null;
    try {
      return JSON.parse(
        await decryptSecret(row.token_cipher, this.env.CREDENTIAL_ENCRYPTION_KEY),
      ) as { clientId: string; clientSecret: string };
    } catch {
      return null;
    }
  }

  private agentWsUrl(): string {
    const base = this.publicUrl();
    return base ? `${base}/agent/ws` : "/agent/ws";
  }

  private async handleAgentAsset(request: Request, path: string): Promise<Response> {
    if (this.role(request) !== "agent") return errorResponse("forbidden", 403);
    const clientId = request.headers.get("x-ecp-access-client-id") || "";
    const row = this.agentByClientId(clientId);
    if (!row || row.disabled !== 0) return errorResponse("agent not registered", 403);
    if (path === "/internal/agent/install.sh" && request.method === "GET") {
      return this.handleInstallScript(request);
    }
    if (path.startsWith("/internal/agent/download/") && request.method === "GET") {
      return this.handleDownload(request, path.slice("/internal/agent/download/".length));
    }
    return errorResponse("not found", 404);
  }

  private async handleInstallScript(request: Request): Promise<Response> {
    void request;
    let response: Response;
    try {
      response = await this.env.ASSETS.fetch(
        new Request(`${this.publicUrl()}/downloads/install.sh`),
      );
    } catch {
      return errorResponse("install script is unavailable", 503);
    }
    if (!response.ok) return errorResponse("install script is unavailable", 503);
    const text = new TextDecoder().decode(await response.arrayBuffer());
    if (!text || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
      return errorResponse("install script is unavailable", 503);
    }
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private async handleDownload(request: Request, archRaw: string): Promise<Response> {
    void request;
    const arch = archRaw.replace(/\.(exe|bin)$/, "");
    if (arch !== "amd64" && arch !== "arm64") return errorResponse("unsupported architecture", 404);
    let response: Response;
    try {
      response = await this.env.ASSETS.fetch(
        new Request(`${this.publicUrl()}/downloads/edge-agent-linux-${arch}`),
      );
    } catch {
      return errorResponse("agent binary is unavailable", 503);
    }
    if (!response.ok) return errorResponse("agent binary is unavailable", 503);
    const type = response.headers.get("content-type") || "";
    if (type.includes("text/html")) return errorResponse("agent binary is unavailable", 503);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="edge-agent-linux-${arch}"`);
    return new Response(response.body, { status: 200, headers });
  }
}

class AccessInternalError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
  }
}

function runTimeout(run: RunRow): number {
  return run.timeout_sec * 1000;
}
