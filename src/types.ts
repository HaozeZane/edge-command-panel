export interface Env {
  ASSETS: Fetcher;
  HUB: DurableObjectNamespace;

  PUBLIC_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_UI_AUD: string;
  ACCESS_API_AUD: string;
  ACCESS_AGENT_AUD: string;
  ACCESS_ENROLL_AUD: string;
  ACCESS_API_CLIENT_ID?: string;

  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AGENT_ACCESS_APP_ID?: string;
  AGENT_ACCESS_POLICY_ID?: string;
  ENROLL_ACCESS_APP_ID?: string;
  ENROLL_ACCESS_POLICY_ID?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;

  /** Test/development only, accepted only for loopback issuer and request. */
  ACCESS_JWKS?: string;
  /** Test only, accepted only with a loopback PUBLIC_URL. */
  CLOUDFLARE_API_BASE?: string;

  USAGE_REQUESTS_LIMIT?: string;
  USAGE_ROWS_READ_LIMIT?: string;
  USAGE_ROWS_WRITTEN_LIMIT?: string;
  USAGE_LOG_FRAMES_LIMIT?: string;
  USAGE_STORAGE_BYTES_LIMIT?: string;
}

export interface AccessIdentity {
  email?: string;
  commonName?: string;
  sub?: string;
  aud: string;
  exp: number;
  raw: Record<string, unknown>;
}

export type Role = "ui" | "api" | "agent" | "enroll";

export interface ProvisionConfig {
  apiToken: string;
  accountId: string;
  agentAppId: string;
  agentPolicyId: string;
  enrollAppId: string;
  enrollPolicyId: string;
  encryptionKey: string;
}
