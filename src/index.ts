import { AccessError, identityLabel, requireServiceIdentity, verifyAccess } from "./access";
import { CommandHub } from "./hub";
import { ConfigError } from "./cloudflare";
import type { AccessIdentity, Env, Role } from "./types";
import {
  ValidationError,
  errorResponse,
  isLoopbackHostname,
  normalizeOrigin,
} from "./util";

export { CommandHub };

const ADMIN_BODY_LIMIT = 128 * 1024;
const ENROLL_BODY_LIMIT = 16 * 1024;
const AUTH_HEADER = "cf-access-jwt-assertion";

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function requireAuthConfig(env: Env): URL {
  const missing = [
    env.PUBLIC_URL,
    env.ACCESS_TEAM_DOMAIN,
    env.ACCESS_UI_AUD,
    env.ACCESS_API_AUD,
    env.ACCESS_AGENT_AUD,
    env.ACCESS_ENROLL_AUD,
  ].some((value) => !value || !String(value).trim());
  if (missing) throw new HttpError("authentication configuration is incomplete", 503);
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_URL);
  } catch {
    throw new HttpError("PUBLIC_URL is invalid", 503);
  }
  if (publicUrl.protocol !== "https:" && !isLoopbackHostname(publicUrl.hostname)) {
    throw new HttpError("PUBLIC_URL must use https outside loopback", 503);
  }
  return publicUrl;
}

function sameOrigin(request: Request, publicUrl: URL, required: boolean): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    if (required) throw new HttpError("same-origin Origin header required", 403);
    return;
  }
  try {
    if (normalizeOrigin(origin) !== publicUrl.origin) {
      throw new HttpError("cross-origin request rejected", 403);
    }
  } catch {
    throw new HttpError("invalid Origin header", 403);
  }
}

async function readLimited(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError("request body too large", 413);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("request body too large", 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function jsonContentType(request: Request): void {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError("content-type must be application/json", 415);
  }
}

function cleanHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  const keys: string[] = [];
  headers.forEach((_value, key) => keys.push(key));
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("x-ecp-") ||
      lower === AUTH_HEADER ||
      lower === "cookie" ||
      lower === "cf-access-client-id" ||
      lower === "cf-access-client-secret"
    ) {
      headers.delete(key);
    }
  }
  return headers;
}

async function forwardAdmin(
  request: Request,
  env: Env,
  role: "ui" | "api",
  identity: string,
  restPath: string,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";
  let body: string | undefined;
  if (isWrite && request.body) {
    jsonContentType(request);
    body = await readLimited(request, ADMIN_BODY_LIMIT);
  }
  const doUrl = new URL(request.url);
  doUrl.pathname = `/internal/admin${restPath}`;
  doUrl.search = new URL(request.url).search;
  const headers = cleanHeaders(request);
  headers.set("x-ecp-role", role);
  headers.set("x-ecp-identity", identity);
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;
  return env.HUB.get(env.HUB.idFromName("hub")).fetch(new Request(doUrl, init));
}

async function forwardJson(
  request: Request,
  env: Env,
  doPath: string,
  headers: Headers,
  limit: number,
): Promise<Response> {
  const body = await readLimited(request, limit);
  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  const init: RequestInit = { method: request.method, headers, body };
  return env.HUB.get(env.HUB.idFromName("hub")).fetch(new Request(doUrl, init));
}

async function forwardSocket(
  request: Request,
  env: Env,
  doPath: string,
  headers: Headers,
): Promise<Response> {
  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  const forwarded = new Request(doUrl, {
    method: "GET",
    headers,
  });
  return stub.fetch(forwarded);
}

async function forwardAssetProxy(
  request: Request,
  env: Env,
  doPath: string,
  headers: Headers,
): Promise<Response> {
  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  return env.HUB.get(env.HUB.idFromName("hub")).fetch(
    new Request(doUrl, { method: request.method, headers }),
  );
}

function requireCommonName(identity: AccessIdentity): string {
  if (!identity.commonName) throw new HttpError("service token client id missing", 403);
  return identity.commonName;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const publicUrl = requireAuthConfig(env);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse("invalid request URL", 400);
  }
  // Host pinning prevents the Worker from serving data on workers.dev or a
  // misconfigured custom domain.
  if (url.origin !== publicUrl.origin) {
    return errorResponse("host not allowed", 421);
  }
  const path = url.pathname;

  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    const identity = await verifyAccess(request, env, env.ACCESS_API_AUD);
    const clientId = requireServiceIdentity(identity, env);
    const rest = path.slice("/api/v1".length) || "/";
    sameOrigin(request, publicUrl, false);
    return forwardAdmin(request, env, "api", clientId, rest);
  }

  if (path === "/ui-api" || path.startsWith("/ui-api/")) {
    const identity = await verifyAccess(request, env, env.ACCESS_UI_AUD);
    const rest = path.slice("/ui-api".length) || "/";
    if (rest === "/events/ws") {
      sameOrigin(request, publicUrl, true);
      const expiry = Math.min(identity.exp * 1000, Date.now() + 15 * 60 * 1000);
      const headers = cleanHeaders(request);
      headers.set("x-ecp-role", "ui");
      headers.set("x-ecp-identity", identityLabel(identity));
      headers.set("x-ecp-auth-expiry", String(expiry));
      return forwardSocket(request, env, "/internal/events/ws", headers);
    }
    sameOrigin(request, publicUrl, request.method !== "GET" && request.method !== "HEAD");
    return forwardAdmin(request, env, "ui", identityLabel(identity), rest);
  }

  if (path === "/events/ws" || path === "/api/events/ws") {
    const identity = await verifyAccess(request, env, env.ACCESS_UI_AUD);
    sameOrigin(request, publicUrl, true);
    const expiry = Math.min(identity.exp * 1000, Date.now() + 15 * 60 * 1000);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "ui");
    headers.set("x-ecp-identity", identityLabel(identity));
    headers.set("x-ecp-auth-expiry", String(expiry));
    return forwardSocket(request, env, "/internal/events/ws", headers);
  }

  if (path === "/agent/ws") {
    const identity = await verifyAccess(request, env, env.ACCESS_AGENT_AUD);
    const clientId = requireCommonName(identity);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "agent");
    headers.set("x-ecp-access-client-id", clientId);
    headers.set(
      "x-ecp-auth-expiry",
      String(Math.min(identity.exp * 1000, Date.now() + 15 * 60 * 1000)),
    );
    return forwardSocket(request, env, "/internal/agent/ws", headers);
  }
  if (path === "/agent/install.sh") {
    const identity = await verifyAccess(request, env, env.ACCESS_AGENT_AUD);
    const clientId = requireCommonName(identity);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "agent");
    headers.set("x-ecp-access-client-id", clientId);
    return forwardAssetProxy(request, env, "/internal/agent/install.sh", headers);
  }
  if (path.startsWith("/agent/download/")) {
    const identity = await verifyAccess(request, env, env.ACCESS_AGENT_AUD);
    const clientId = requireCommonName(identity);
    const arch = path.slice("/agent/download/".length);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "agent");
    headers.set("x-ecp-access-client-id", clientId);
    return forwardAssetProxy(request, env, `/internal/agent/download/${arch}`, headers);
  }

  if (path === "/enroll/challenge" || path === "/enroll/register") {
    const identity = await verifyAccess(request, env, env.ACCESS_ENROLL_AUD);
    const clientId = requireCommonName(identity);
    jsonContentType(request);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "enroll");
    headers.set("x-ecp-access-client-id", clientId);
    return forwardJson(
      request,
      env,
      path === "/enroll/challenge" ? "/internal/enroll/challenge" : "/internal/enroll/register",
      headers,
      ENROLL_BODY_LIMIT,
    );
  }
  if (path === "/enroll/install.sh") {
    const identity = await verifyAccess(request, env, env.ACCESS_ENROLL_AUD);
    const clientId = requireCommonName(identity);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "enroll");
    headers.set("x-ecp-access-client-id", clientId);
    return forwardAssetProxy(request, env, "/internal/enroll/install.sh", headers);
  }
  if (path.startsWith("/enroll/download/")) {
    const identity = await verifyAccess(request, env, env.ACCESS_ENROLL_AUD);
    const clientId = requireCommonName(identity);
    const arch = path.slice("/enroll/download/".length);
    const headers = cleanHeaders(request);
    headers.set("x-ecp-role", "enroll");
    headers.set("x-ecp-access-client-id", clientId);
    return forwardAssetProxy(request, env, `/internal/enroll/download/${arch}`, headers);
  }

  // Root + all static assets are One-protected too. Data routes are handled
  // above and can never fall through to public assets.
  const identity = await verifyAccess(request, env, env.ACCESS_UI_AUD);
  sameOrigin(request, publicUrl, request.method !== "GET" && request.method !== "HEAD");
  void identity;
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if (/\.(?:js|css|woff2?|png|jpg|svg|wasm|bin)$/i.test(url.pathname)) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else {
    headers.set("cache-control", "no-cache");
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof AccessError) return errorResponse(error.message, error.status);
      if (error instanceof ConfigError) return errorResponse(error.message, 503);
      if (error instanceof HttpError) return errorResponse(error.message, error.status);
      if (error instanceof ValidationError) return errorResponse(error.message, 400);
      console.error("request failed", error instanceof Error ? error.name : "unknown");
      return errorResponse("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
