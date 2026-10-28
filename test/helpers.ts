import { expect } from "vitest";
import { SignJWT } from "jose";
import { SELF } from "cloudflare:test";
import {
  TEST_AUD,
  TEST_ISSUER,
  TEST_PRIVATE_DER_B64,
  TEST_PUBLIC_URL,
} from "./fixtures";

export interface FakeToken {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  duration?: string;
}

export interface FakePolicy {
  name: string;
  decision: string;
  precedence: number;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  [key: string]: unknown;
}

export interface FakeCloudflareState {
  tokens: FakeToken[];
  policies: Record<string, FakePolicy>;
  failPolicyPut: boolean;
  failDelete: boolean;
  dropNextCreateResponse: boolean;
  requests: string[];
}

const realFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cfError(message: string, status = 400) {
  return jsonResponse({ success: false, errors: [{ code: status, message }] }, status);
}

export function installFakeCloudflare(): FakeCloudflareState {
  const state: FakeCloudflareState = {
    tokens: [],
    policies: {
      "agent-policy": {
        name: "Agent devices",
        decision: "non_identity",
        precedence: 1,
        include: [
          { email: { email: "ops@example.com" } },
          { service_token: { token_id: "unmanaged-token" } },
        ],
        exclude: [{ ip: { ip: "203.0.113.9" } }],
        require: [],
        session_duration: "24h",
      },
      "enroll-policy": {
        name: "Enrollment devices",
        decision: "non_identity",
        precedence: 2,
        include: [{ email: { email: "ops@example.com" } }, { service_token: { token_id: "unmanaged-enroll" } }],
        exclude: [],
        require: [],
      },
    },
    failPolicyPut: false,
    failDelete: false,
    dropNextCreateResponse: false,
    requests: [],
  };

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith("http://127.0.0.1:8788/client/v4")) {
      return realFetch(input, init);
    }
    state.requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer test-api-token") return cfError("unauthorized", 401);
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";

    if (path === "/accounts/test-account/access/service_tokens" && method === "GET") {
      // Real Cloudflare One only returns client_secret in the creation response.
      return jsonResponse({
        success: true,
        result: state.tokens.map(({ client_secret, ...token }) => token),
        result_info: { page: 1, per_page: 100, count: state.tokens.length, total_count: state.tokens.length, total_pages: 1 },
      });
    }
    if (path === "/accounts/test-account/access/service_tokens" && method === "POST") {
      if (state.tokens.length >= 50) return cfError("service token limit reached", 403);
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; duration?: string };
      const id = crypto.randomUUID();
      const token: FakeToken = {
        id,
        name: body.name ?? `token-${id}`,
        client_id: `client-${id}`,
        client_secret: `secret-${crypto.randomUUID()}`,
      };
      if (body.duration) token.duration = body.duration;
      state.tokens.push(token);
      if (state.dropNextCreateResponse) {
        state.dropNextCreateResponse = false;
        throw new Error("simulated Cloudflare create response loss");
      }
      return jsonResponse({ success: true, result: token });
    }
    const tokenDelete = /^\/accounts\/test-account\/access\/service_tokens\/([^/]+)$/.exec(path);
    if (tokenDelete && method === "DELETE") {
      if (state.failDelete) return cfError("cannot delete", 500);
      state.tokens = state.tokens.filter((t) => t.id !== tokenDelete[1]);
      return jsonResponse({ success: true, result: {} });
    }
    const policyMatch = /^\/accounts\/test-account\/access\/apps\/([^/]+)\/policies\/([^/]+)$/.exec(path);
    if (policyMatch) {
      const [, app, policyId] = policyMatch;
      if (app !== "agent-app" && app !== "enroll-app") return cfError("unknown app", 404);
      const policy = state.policies[policyId!];
      if (!policy) return cfError("unknown policy", 404);
      if (method === "GET") return jsonResponse({ success: true, result: policy });
      if (method === "PUT") {
        if (state.failPolicyPut) return cfError("policy update failed", 500);
        state.policies[policyId!] = JSON.parse(String(init?.body ?? "{}")) as FakePolicy;
        return jsonResponse({ success: true, result: state.policies[policyId!] });
      }
    }
    return cfError("not found", 404);
  };
  (globalThis as { fetch: typeof fetch }).fetch = fakeFetch as typeof fetch;
  return state;
}

export function restoreFetch(): void {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
}

let privateKey: CryptoKey | undefined;

export async function signAccessJwt(options: {
  aud: string;
  commonName?: string;
  email?: string;
  sub?: string;
  exp?: number;
  issuer?: string;
  subject?: string;
}): Promise<string> {
  if (!privateKey) {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(unb64(TEST_PRIVATE_DER_B64)).buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  const claims: Record<string, unknown> = {};
  if (options.commonName) claims.common_name = options.commonName;
  if (options.email) claims.email = options.email;
  const issued = Math.floor(Date.now() / 1000) - 10;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.aud)
    .setSubject(options.sub ?? options.subject ?? "user-test")
    .setIssuedAt(issued)
    .setExpirationTime(options.exp ?? issued + 3600)
    .sign(privateKey);
}

export async function uiToken(): Promise<string> {
  return signAccessJwt({ aud: TEST_AUD.ui, email: "admin@example.com", sub: "user-1" });
}

export async function apiToken(commonName = "api-client"): Promise<string> {
  return signAccessJwt({ aud: TEST_AUD.api, commonName, sub: "" });
}

export async function agentToken(commonName: string, exp?: number): Promise<string> {
  return signAccessJwt({ aud: TEST_AUD.agent, commonName, sub: "", exp });
}

export async function enrollToken(commonName: string): Promise<string> {
  return signAccessJwt({ aud: TEST_AUD.enroll, commonName, sub: "" });
}

export interface CallOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
  rawBody?: string;
  url?: string;
}

export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== null && options.token !== undefined) {
    headers.set("cf-access-jwt-assertion", options.token);
  }
  if (options.origin) headers.set("origin", options.origin);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(options.url ?? `${TEST_PUBLIC_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });
}

export async function uiCall(path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  return call(path, {
    ...options,
    token: options.token === undefined ? await uiToken() : options.token,
    origin:
      options.origin === undefined && method !== "GET" && method !== "HEAD"
        ? TEST_PUBLIC_URL
        : options.origin,
  });
}

export async function createAgent(
  fake: FakeCloudflareState,
  name?: string,
  groupIds: string[] = [],
  requestId = crypto.randomUUID(),
): Promise<{ agent: any; token: FakeToken; requestId: string }> {
  const response = await uiCall("/ui-api/agents", {
    method: "POST",
    body: { requestId, ...(name === undefined ? {} : { name }), groupIds },
  });
  expect([200, 201]).toContain(response.status);
  const data = (await response.json()) as { agent: any };
  const token = fake.tokens.find((t) => t.name === `ecp-a-${requestId}`);
  expect(token).toBeTruthy();
  return { agent: data.agent, token: token!, requestId };
}

export async function createGroup(name: string): Promise<any> {
  const response = await uiCall("/ui-api/groups", { method: "POST", body: { name } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { group: any }).group;
}

export interface SocketClient {
  ws: WebSocket;
  next: (timeoutMs?: number) => Promise<any>;
  waitFor: (predicate: (value: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (value: unknown) => void;
  sendText: (value: string) => void;
  close: (code?: number, reason?: string) => void;
  closed: Promise<{ code: number; reason: string }>;
}

function wrapSocket(ws: WebSocket): SocketClient {
  const queue: any[] = [];
  const waiters: { predicate: (value: any) => boolean; resolve: (value: any) => void }[] = [];
  let closedResolve: (value: { code: number; reason: string }) => void = () => undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    closedResolve = resolve;
  });
  ws.addEventListener("message", (event) => {
    let value: any = event.data;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        // plain text ping/pong
      }
    }
    const index = waiters.findIndex((w) => w.predicate(value));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0]!;
      waiter.resolve(value);
    } else {
      queue.push(value);
    }
  });
  ws.addEventListener("close", (event) => {
    closedResolve({ code: event.code, reason: event.reason });
  });
  ws.accept();
  return {
    ws,
    async next(timeoutMs = 3000) {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === wrapped);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("websocket message timeout"));
        }, timeoutMs);
        const wrapped = (value: any) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push({ predicate: () => true, resolve: wrapped });
      });
    },
    async waitFor(predicate, timeoutMs = 3000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return queue.splice(index, 1)[0];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("websocket predicate timeout"));
        }, timeoutMs);
        const wrapped = (value: any) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.push({ predicate, resolve: wrapped });
      });
    },
    send(value: unknown) {
      ws.send(JSON.stringify(value));
    },
    sendText(value: string) {
      ws.send(value);
    },
    close(code = 1000, reason = "test") {
      ws.close(code, reason);
    },
    closed,
  };
}

export async function openAgentSocket(clientId: string, exp?: number): Promise<SocketClient> {
  const token = await agentToken(clientId, exp);
  const response = await SELF.fetch(`${TEST_PUBLIC_URL}/agent/ws`, {
    headers: {
      upgrade: "websocket",
      "cf-access-jwt-assertion": token,
    },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  return wrapSocket(response.webSocket!);
}

export async function openBrowserSocket(): Promise<SocketClient> {
  const token = await uiToken();
  const response = await SELF.fetch(`${TEST_PUBLIC_URL}/events/ws`, {
    headers: {
      upgrade: "websocket",
      origin: TEST_PUBLIC_URL,
      "cf-access-jwt-assertion": token,
    },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  return wrapSocket(response.webSocket!);
}

export async function hello(socket: SocketClient, options: { runs?: any[] } = {}): Promise<void> {
  socket.send({
    v: 1,
    type: "hello",
    bootId: crypto.randomUUID(),
    version: "test-1.0",
    hostname: `host-${crypto.randomUUID()}`,
    runs: options.runs ?? [],
  });
}

export async function waitAgentOnline(
  agentId: string,
  timeoutMs = 3000,
): Promise<any> {
  const started = Date.now();
  for (;;) {
    const response = await uiCall("/ui-api/agents");
    expect(response.status).toBe(200);
    const agents = ((await response.json()) as { agents: any[] }).agents;
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.online) return agent;
    if (Date.now() - started > timeoutMs) throw new Error("agent did not become online");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function b64(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

export function unb64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
