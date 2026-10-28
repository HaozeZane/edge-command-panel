import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AccessIdentity, Env } from "./types";
import { isLoopbackHostname } from "./util";

const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const localSets = new Map<string, ReturnType<typeof createLocalJWKSet>>();

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

function teamIssuer(env: Env, requestUrl: URL): string {
  const raw = (env.ACCESS_TEAM_DOMAIN || "").trim();
  if (!raw) throw new AccessError("ACCESS_TEAM_DOMAIN is not configured", 503);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new AccessError("ACCESS_TEAM_DOMAIN is invalid", 503);
  }
  if (url.protocol !== "https:") {
    if (
      url.protocol !== "http:" ||
      !isLoopbackHostname(url.hostname) ||
      !isLoopbackHostname(requestUrl.hostname)
    ) {
      throw new AccessError("Access issuer must use https", 503);
    }
  }
  return url.origin;
}

function localJwks(env: Env, issuer: string, requestUrl: URL) {
  if (!env.ACCESS_JWKS) return null;
  if (!isLoopbackHostname(new URL(issuer).hostname) || !isLoopbackHostname(requestUrl.hostname)) {
    throw new AccessError("ACCESS_JWKS is only allowed for loopback testing", 503);
  }
  let parsed: { keys?: unknown };
  try {
    parsed = JSON.parse(env.ACCESS_JWKS) as { keys?: unknown };
  } catch {
    throw new AccessError("ACCESS_JWKS is invalid", 503);
  }
  if (!Array.isArray(parsed.keys)) throw new AccessError("ACCESS_JWKS is invalid", 503);
  return createLocalJWKSet(parsed as Parameters<typeof createLocalJWKSet>[0]);
}

export async function verifyAccess(
  request: Request,
  env: Env,
  audience: string,
): Promise<AccessIdentity> {
  if (!audience) throw new AccessError("Access audience is not configured", 503);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AccessError("missing Access JWT", 401);
  const requestUrl = new URL(request.url);
  const issuer = teamIssuer(env, requestUrl);
  const local = localJwks(env, issuer, requestUrl);

  let payload: JWTPayload;
  try {
    let keySet;
    if (local) {
      keySet = local;
    } else {
      let cached = remoteSets.get(issuer);
      if (!cached) {
        cached = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
          cacheMaxAge: 10 * 60 * 1000,
          cooldownDuration: 30_000,
        });
        remoteSets.set(issuer, cached);
      }
      keySet = cached;
    }
    const verified = await jwtVerify(token, keySet, {
      issuer,
      audience,
      clockTolerance: 5,
      algorithms: ["RS256", "ES256", "EdDSA"],
    });
    payload = verified.payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid token";
    if (/fetch|network|jwks/i.test(message)) {
      throw new AccessError("Access key set unavailable", 503);
    }
    throw new AccessError("invalid Access JWT", 401);
  }

  if (typeof payload.exp !== "number") throw new AccessError("Access JWT has no exp", 401);
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const commonName = typeof payload.common_name === "string" ? payload.common_name : undefined;
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!email && !commonName && !sub) throw new AccessError("Access JWT has no identity", 401);

  return {
    email,
    commonName,
    sub,
    aud: audience,
    exp: payload.exp,
    raw: payload as Record<string, unknown>,
  };
}

export function identityLabel(identity: AccessIdentity): string {
  return identity.email || identity.commonName || identity.sub || "unknown";
}

export function requireServiceIdentity(identity: AccessIdentity, env: Env): string {
  if (!identity.commonName) throw new AccessError("service token client id missing", 403);
  if (env.ACCESS_API_CLIENT_ID && identity.commonName !== env.ACCESS_API_CLIENT_ID) {
    throw new AccessError("service token is not allowed", 403);
  }
  return identity.commonName;
}
