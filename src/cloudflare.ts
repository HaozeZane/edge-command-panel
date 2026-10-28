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
  id?: string;
  account_id?: string;
  app_count?: number;
  reusable?: boolean;
  name?: string;
  decision?: string;
  precedence?: number;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  [key: string]: unknown;
}

interface AccessApplicationBody {
  id?: string;
  policies?: Array<{ id?: string } | string>;
}

interface ResolvedPolicy {
  kind: "reusable" | "legacy";
  policy: PolicyBody;
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

  private async getApplication(appId: string): Promise<AccessApplicationBody> {
    return this.request<AccessApplicationBody>(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/apps/${encodeURIComponent(appId)}`,
    );
  }

  private async getReusablePolicy(policyId: string): Promise<PolicyBody> {
    return this.request<PolicyBody>(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/policies/${encodeURIComponent(policyId)}`,
    );
  }

  private async getLegacyPolicy(appId: string, policyId: string): Promise<PolicyBody> {
    return this.request<PolicyBody>(
      `/accounts/${encodeURIComponent(this.config.accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policyId)}`,
    );
  }

  private static policyIds(app: AccessApplicationBody): string[] {
    const policies = Array.isArray(app.policies) ? app.policies : [];
    return policies
      .map((policy) => (typeof policy === "string" ? policy : policy?.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  private static assertApplicationPolicy(
    app: AccessApplicationBody,
    appId: string,
    policyId: string,
  ): void {
    if (app.id !== appId) {
      throw new ConfigError(
        `Access application ${appId} returned a different id; check AGENT_ACCESS_APP_ID / ENROLL_ACCESS_APP_ID`,
      );
    }
    if (!CloudflareAccessApi.policyIds(app).includes(policyId)) {
      throw new ConfigError(
        `Access application ${appId} does not contain policy ${policyId}; configure dedicated Agent/Enroll policies and use their exact ids`,
      );
    }
  }

  private assertPolicy(
    policy: PolicyBody,
    policyId: string,
    kind: ResolvedPolicy["kind"],
  ): PolicyBody {
    if (!policy || policy.id !== policyId) {
      throw new ConfigError(
        `Access policy ${policyId} response id does not match; check AGENT_ACCESS_POLICY_ID / ENROLL_ACCESS_POLICY_ID`,
      );
    }
    if (policy.decision !== "non_identity") {
      throw new ConfigError(
        `Access policy ${policyId} must use decision non_identity (Service Auth); configure a dedicated Agent/Enroll policy`,
      );
    }
    if (kind === "legacy" && policy.reusable === true) {
      throw new ConfigError(
        `Access policy ${policyId} is reusable but was returned by the application-level endpoint; refusing to update it through the legacy endpoint`,
      );
    }
    if (kind === "reusable") {
      if (
        policy.account_id !== undefined &&
        String(policy.account_id).toLowerCase() !== this.config.accountId.toLowerCase()
      ) {
        throw new ConfigError(
          `Access reusable policy ${policyId} belongs to a different account; check CLOUDFLARE_ACCOUNT_ID`,
        );
      }
      if (policy.app_count !== 1) {
        const count =
          policy.app_count === undefined ? "missing app_count" : String(policy.app_count);
        throw new ConfigError(
          `Access reusable policy ${policyId} must be attached to exactly one application (${count}); configure separate dedicated policies for Agent and Enroll`,
        );
      }
    }
    return policy;
  }

  private async resolvePolicy(appId: string, policyId: string): Promise<ResolvedPolicy> {
    const app = await this.getApplication(appId);
    CloudflareAccessApi.assertApplicationPolicy(app, appId, policyId);
    try {
      const policy = await this.getReusablePolicy(policyId);
      return { kind: "reusable", policy: this.assertPolicy(policy, policyId, "reusable") };
    } catch (error) {
      // Only an explicit account-level 404 may fall back to the legacy
      // application-level endpoint. Auth, rate-limit, server and network
      // failures must surface without a retry or a second write path.
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const policy = await this.getLegacyPolicy(appId, policyId);
    return { kind: "legacy", policy: this.assertPolicy(policy, policyId, "legacy") };
  }

  private static policyPayload(policy: PolicyBody, kind: ResolvedPolicy["kind"]): PolicyBody {
    const allowed = [
      "name",
      "decision",
      "include",
      "exclude",
      "require",
      "approval_groups",
      "approval_required",
      "connection_rules",
      "isolation_required",
      "mfa_config",
      "purpose_justification_prompt",
      "purpose_justification_required",
      "session_duration",
      "policy_resolution_account_id",
    ];
    if (kind === "legacy") allowed.push("precedence");
    const out: PolicyBody = {};
    for (const key of allowed) {
      if (key in policy) out[key] = policy[key];
    }
    return out;
  }

  private async putPolicy(
    appId: string,
    policyId: string,
    resolved: ResolvedPolicy,
    policy: PolicyBody,
  ): Promise<void> {
    const path =
      resolved.kind === "reusable"
        ? `/accounts/${encodeURIComponent(this.config.accountId)}/access/policies/${encodeURIComponent(policyId)}`
        : `/accounts/${encodeURIComponent(this.config.accountId)}/access/apps/${encodeURIComponent(appId)}/policies/${encodeURIComponent(policyId)}`;
    await this.request(path, {
      method: "PUT",
      body: JSON.stringify(CloudflareAccessApi.policyPayload(policy, resolved.kind)),
    });
  }

  private static hasToken(include: unknown[], tokenId: string): boolean {
    return include.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      const st = (rule as { service_token?: { token_id?: unknown } }).service_token;
      return st?.token_id === tokenId;
    });
  }

  async addServiceTokenToPolicy(appId: string, policyId: string, tokenId: string): Promise<void> {
    const resolved = await this.resolvePolicy(appId, policyId);
    const policy = resolved.policy;
    const include = Array.isArray(policy.include) ? [...policy.include] : [];
    if (CloudflareAccessApi.hasToken(include, tokenId)) return;
    include.push({ service_token: { token_id: tokenId } });
    await this.putPolicy(appId, policyId, resolved, { ...policy, include });
  }

  async removeServiceTokenFromPolicy(
    appId: string,
    policyId: string,
    tokenId: string,
  ): Promise<void> {
    const resolved = await this.resolvePolicy(appId, policyId);
    const policy = resolved.policy;
    const current = Array.isArray(policy.include) ? policy.include : [];
    const include = current.filter((rule) => {
      if (!rule || typeof rule !== "object") return true;
      const st = (rule as { service_token?: { token_id?: unknown } }).service_token;
      return st?.token_id !== tokenId;
    });
    if (include.length === current.length) return;
    await this.putPolicy(appId, policyId, resolved, { ...policy, include });
  }
}

export const SERVICE_TOKEN_LIMIT = 50;
