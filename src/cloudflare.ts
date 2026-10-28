import type { Env, ProvisionConfig } from "./types";
import { isLoopbackHostname } from "./util";
import { validEncryptionKey } from "./crypto";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface CfServiceToken {
  id: string;
  name?: string;
  client_id: string;
  client_secret?: string;
}

interface PolicyBody {
  name?: string;
  decision?: string;
  precedence?: number;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  [key: string]: unknown;
}

export function provisionConfig(env: Env): ProvisionConfig {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const agentAppId = env.AGENT_ACCESS_APP_ID;
  const agentPolicyId = env.AGENT_ACCESS_POLICY_ID;
  const enrollAppId = env.ENROLL_ACCESS_APP_ID;
  const enrollPolicyId = env.ENROLL_ACCESS_POLICY_ID;
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  if (
    !apiToken ||
    !accountId ||
    !agentAppId ||
    !agentPolicyId ||
    !enrollAppId ||
    !enrollPolicyId ||
    !encryptionKey
  ) {
    throw new ConfigError("provisioning configuration is incomplete");
  }
  if (!validEncryptionKey(encryptionKey)) throw new ConfigError("CREDENTIAL_ENCRYPTION_KEY is invalid");
  return { apiToken, accountId, agentAppId, agentPolicyId, enrollAppId, enrollPolicyId, encryptionKey };
}

export function hasProvisionConfig(env: Env): boolean {
  try {
    provisionConfig(env);
    return true;
  } catch {
    return false;
  }
}

function apiBase(env: Env): string {
  const configured = env.CLOUDFLARE_API_BASE;
  if (!configured) return "https://api.cloudflare.com/client/v4";
  let base: URL;
  let publicUrl: URL;
  try {
    base = new URL(configured);
    publicUrl = new URL(env.PUBLIC_URL);
  } catch {
    throw new ConfigError("CLOUDFLARE_API_BASE or PUBLIC_URL is invalid");
  }
  if (
    !isLoopbackHostname(base.hostname) ||
    !isLoopbackHostname(publicUrl.hostname) ||
    !["http:", "https:"].includes(base.protocol)
  ) {
    throw new ConfigError("CLOUDFLARE_API_BASE override is only allowed for loopback tests");
  }
  return configured.replace(/\/$/, "");
}

export class CloudflareAccessApi {
  private readonly base: string;

  constructor(private readonly config: ProvisionConfig, env: Env) {
    this.base = apiBase(env);
  }

  private async requestRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.apiToken}`);
    headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new CloudflareApiError("Cloudflare API request failed");
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Keep error text generic and secret-free.
    }
    const success =
      response.ok &&
      (typeof body !== "object" ||
        body === null ||
        !("success" in body) ||
        (body as { success?: unknown }).success === true);
    if (!success) {
      let detail = "";
      if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors)) {
        const first = (body as { errors: unknown[] }).errors[0];
        if (first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string") {
          detail = (first as { message: string }).message.slice(0, 160);
        }
      }
      throw new CloudflareApiError(
        `Cloudflare API rejected the request${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    return body as T;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = await this.requestRaw<{ result?: T } | T>(path, init);
    if (body && typeof body === "object" && "result" in body) {
      return (body as { result: T }).result;
    }
    return body as T;
  }

  async listServiceTokens(): Promise<CfServiceToken[]> {
    const tokens: CfServiceToken[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await this.requestRaw<{
        result?: CfServiceToken[];
        result_info?: { total_pages?: number };
      }>(
        `/accounts/${encodeURIComponent(this.config.accountId)}/access/service_tokens?per_page=100&page=${page}`,
      );
      const rows = body.result ?? [];
      tokens.push(...rows);
      const pages = body.result_info?.total_pages ?? 1;
      if (page >= pages || rows.length === 0) break;
    }
    return tokens;
  }

  async createServiceToken(name: string, duration?: string): Promise<CfServiceToken> {
    const result = await this.request<CfServiceToken>(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/service_tokens`,
      { method: "POST", body: JSON.stringify(duration ? { name, duration } : { name }) },
    );
    if (!result?.id || !result.client_id || !result.client_secret) {
      throw new CloudflareApiError("Cloudflare API returned an incomplete service token");
    }
    return result;
  }

  async deleteServiceToken(tokenId: string): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/service_tokens/${encodeURIComponent(tokenId)}`,
      { method: "DELETE" },
    );
  }

  async findServiceTokenByName(name: string): Promise<CfServiceToken | undefined> {
    const tokens = await this.listServiceTokens();
    return tokens.find((t) => t.name === name);
  }

  private async getPolicy(appId: string, policyId: string): Promise<PolicyBody> {
    return this.request<PolicyBody>(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policyId)}`,
    );
  }

  private static policyPayload(policy: PolicyBody): PolicyBody {
    const allowed = [
      "name",
      "decision",
      "precedence",
      "include",
      "exclude",
      "require",
      "approval_required",
      "isolation_required",
      "purpose_justification_required",
      "purpose_justification_prompt",
      "session_duration",
    ];
    const out: PolicyBody = {};
    for (const key of allowed) {
      if (key in policy) out[key] = policy[key];
    }
    return out;
  }

  private async putPolicy(appId: string, policyId: string, policy: PolicyBody): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policyId)}`,
      { method: "PUT", body: JSON.stringify(CloudflareAccessApi.policyPayload(policy)) },
    );
  }

  private static hasToken(include: unknown[], tokenId: string): boolean {
    return include.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      const st = (rule as { service_token?: { token_id?: unknown } }).service_token;
      return st?.token_id === tokenId;
    });
  }

  async addServiceTokenToPolicy(appId: string, policyId: string, tokenId: string): Promise<void> {
    const policy = await this.getPolicy(appId, policyId);
    const include = Array.isArray(policy.include) ? [...policy.include] : [];
    if (!CloudflareAccessApi.hasToken(include, tokenId)) {
      include.push({ service_token: { token_id: tokenId } });
    }
    await this.putPolicy(appId, policyId, { ...policy, include });
  }

  async removeServiceTokenFromPolicy(
    appId: string,
    policyId: string,
    tokenId: string,
  ): Promise<void> {
    const policy = await this.getPolicy(appId, policyId);
    const include = (Array.isArray(policy.include) ? policy.include : []).filter((rule) => {
      if (!rule || typeof rule !== "object") return true;
      const st = (rule as { service_token?: { token_id?: unknown } }).service_token;
      return st?.token_id !== tokenId;
    });
    await this.putPolicy(appId, policyId, { ...policy, include });
  }
}

export const SERVICE_TOKEN_LIMIT = 50;
