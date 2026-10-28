import type {
  Agent,
  AgentListResponse,
  Batch,
  BatchDetailResponse,
  BatchListResponse,
  Enrollment,
  EnrollmentListResponse,
  EventsResponse,
  Group,
  GroupListResponse,
  InstallInfo,
  LoginResult,
  Run,
  Usage,
} from '../types/protocol';

export class ApiError extends Error {
  public status: number;
  public isAuthError: boolean;

  constructor(message: string, status: number, isAuthError = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isAuthError = isAuthError;
  }
}

export class SessionExpiredError extends ApiError {
  constructor(message = '会话已过期或未通过 Cloudflare Access 验证，请刷新页面重新登录') {
    super(message, 401, true);
    this.name = 'SessionExpiredError';
  }
}

const API_PREFIX = '/ui-api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_PREFIX}${path}`;
  const headers = new Headers(options.headers || {});
  const method = (options.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';

  // Every backend write endpoint requires application/json, including
  // body-less POST/DELETE actions (disable, rotate, revoke, delete...).
  if (isWrite && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let body = options.body;
  if (isWrite && (body === undefined || body === null)) {
    body = '{}';
  }

  const response = await fetch(url, {
    ...options,
    body,
    credentials: 'include',
    headers,
  });

  const contentType = response.headers.get('content-type') || '';

  // Detect Cloudflare Access 302 login redirect or HTML response
  if (contentType.includes('text/html')) {
    throw new SessionExpiredError();
  }

  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    let errorMessage = `请求失败 (${response.status} ${response.statusText})`;
    try {
      if (contentType.includes('application/json')) {
        const errorJson = await response.json();
        if (errorJson && typeof errorJson.error === 'string') {
          errorMessage = errorJson.error;
        }
      } else {
        const text = await response.text();
        if (text) errorMessage = text.slice(0, 300);
      }
    } catch {
      // Ignore json parse error and keep statusText
    }
    throw new ApiError(errorMessage, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  // Session
  getSession: () => request<LoginResult>('/session'),

  // Agents
  getAgents: () => request<AgentListResponse>('/agents'),
  createAgent: (data: { requestId: string; name?: string; groupIds?: string[] }) =>
    request<{ agent: Agent }>('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAgent: (id: string, data: { name?: string; groupIds?: string[] }) =>
    request<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  disableAgent: (id: string) =>
    request<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
    }),
  rotateAgentToken: (id: string) =>
    request<{ agent: Agent }>(`/agents/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
    }),
  getAgentInstall: (id: string) =>
    request<InstallInfo>(`/agents/${encodeURIComponent(id)}/install`),
  probeAgents: (agentIds: string[]) =>
    request<{ ok: boolean }>('/agents/probe', {
      method: 'POST',
      body: JSON.stringify({ agentIds }),
    }),

  // Groups
  getGroups: () => request<GroupListResponse>('/groups'),
  createGroup: (name: string) =>
    request<{ group: Group }>('/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateGroup: (id: string, name: string) =>
    request<{ group: Group }>(`/groups/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteGroup: (id: string) =>
    request<{ ok: boolean }>(`/groups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  // Enrollments
  getEnrollments: () => request<EnrollmentListResponse>('/enrollments'),
  createEnrollment: (data: {
    requestId: string;
    name: string;
    groupIds: string[];
    maxAgents: number;
    ttlMinutes: number;
  }) =>
    request<{ enrollment: Enrollment; install: InstallInfo }>('/enrollments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getEnrollmentInstall: (id: string) =>
    request<InstallInfo>(`/enrollments/${encodeURIComponent(id)}/install`),
  revokeEnrollment: (id: string) =>
    request<{ ok: boolean }>(`/enrollments/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    }),

  // Batches & Runs
  createBatch: (data: {
    requestId: string;
    agentIds: string[];
    groupIds?: string[];
    command: string;
    timeoutSec: number;
  }) =>
    request<{ batch: Batch; runs: Run[] }>('/batches', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getBatches: (cursor?: string | null) => {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request<BatchListResponse>(`/batches${q}`);
  },
  getBatchDetail: (id: string, signal?: AbortSignal) =>
    request<BatchDetailResponse>(`/batches/${encodeURIComponent(id)}`, { signal }),
  getRunEvents: (runId: string, afterSeq = 0, signal?: AbortSignal) =>
    request<EventsResponse>(
      `/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
      { signal },
    ),

  // Usage
  getUsage: () => request<Usage>('/usage'),
};
