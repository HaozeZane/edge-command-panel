import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, reset } from "cloudflare:test";
import { CloudflareAccessApi } from "../src/cloudflare";
import type { ProvisionConfig } from "../src/types";
import {
  createAgent,
  installFakeCloudflare,
  restoreFetch,
  uiCall,
} from "./helpers";
import type { FakeCloudflareState, FakePolicy } from "./helpers";
import { ENCRYPTION_KEY } from "./fixtures";

const CONFIG: ProvisionConfig = {
  apiToken: "test-api-token",
  accountId: "test-account",
  agentAppId: "agent-app",
  agentPolicyId: "agent-policy",
  enrollAppId: "enroll-app",
  enrollPolicyId: "enroll-policy",
  encryptionKey: ENCRYPTION_KEY,
};

function api(): CloudflareAccessApi {
  return new CloudflareAccessApi(CONFIG, env as any);
}

function policyTokens(policy: FakePolicy | undefined): string[] {
  return ((policy?.include ?? []) as any[])
    .filter((rule) => rule?.service_token?.token_id)
    .map((rule) => rule.service_token.token_id);
}

function putRequests(fake: FakeCloudflareState): string[] {
  return fake.requests.filter((request) => request.startsWith("PUT "));
}

async function createEnrollment(fake: FakeCloudflareState) {
  const requestId = crypto.randomUUID();
  const response = await uiCall("/ui-api/enrollments", {
    method: "POST",
    body: { requestId, name: "site-a", groupIds: [], maxAgents: 1, ttlMinutes: 30 },
  });
  return { requestId, response };
}

describe("Cloudflare Access reusable policy updates", () => {
  let fake: FakeCloudflareState;
  beforeEach(async () => {
    await reset();
    fake = installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("uses the account-level GET/PUT for a modern reusable policy and preserves writable fields", async () => {
    await api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token");

    expect(fake.policyPuts).toHaveLength(1);
    const put = fake.policyPuts[0]!;
    expect(put.path).toBe("/accounts/test-account/access/policies/agent-policy");
    expect(putRequests(fake)).not.toContain(
      "PUT /accounts/test-account/access/apps/agent-app/policies/agent-policy",
    );

    const body = put.body as Record<string, any>;
    expect(body.include).toContainEqual({ service_token: { token_id: "new-token" } });
    expect(body.include).toContainEqual({ service_token: { token_id: "unmanaged-token" } });
    expect(body.exclude).toEqual([{ ip: { ip: "203.0.113.9" } }]);
    expect(body.require).toEqual([]);
    for (const key of [
      "name",
      "decision",
      "approval_required",
      "approval_groups",
      "connection_rules",
      "mfa_config",
      "purpose_justification_prompt",
      "purpose_justification_required",
      "session_duration",
    ]) {
      expect(body).toHaveProperty(key);
    }
    for (const key of [
      "id",
      "account_id",
      "app_count",
      "reusable",
      "created_at",
      "updated_at",
      "precedence",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("does not PUT for a duplicate add or removing an absent token", async () => {
    await api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token");
    fake.policyPuts.length = 0;
    await api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token");
    await api().removeServiceTokenFromPolicy("agent-app", "agent-policy", "absent-token");
    expect(fake.policyPuts).toHaveLength(0);
  });

  it("removes only the target token from a reusable policy", async () => {
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: "external-token" },
    });
    await api().removeServiceTokenFromPolicy("agent-app", "agent-policy", "unmanaged-token");
    expect(fake.policyPuts).toHaveLength(1);
    expect(fake.policyPuts[0]!.path).toBe(
      "/accounts/test-account/access/policies/agent-policy",
    );
    expect(policyTokens(fake.policies["agent-policy"])).not.toContain("unmanaged-token");
    expect(policyTokens(fake.policies["agent-policy"])).toContain("external-token");
  });

  it("allows a reusable policy without account_id but still requires app_count=1", async () => {
    delete fake.policies["agent-policy"]!.account_id;
    await api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token");
    expect(fake.policyPuts[0]!.path).toBe(
      "/accounts/test-account/access/policies/agent-policy",
    );
  });

  it("falls back to the application-level GET/PUT only on an explicit 404", async () => {
    fake.legacyPolicyIds.add("agent-policy");
    delete fake.policies["agent-policy"]!.reusable;
    delete fake.policies["agent-policy"]!.account_id;
    delete fake.policies["agent-policy"]!.app_count;

    await api().addServiceTokenToPolicy("agent-app", "agent-policy", "legacy-token");

    expect(fake.requests).toContain(
      "GET /accounts/test-account/access/policies/agent-policy",
    );
    expect(fake.requests).toContain(
      "GET /accounts/test-account/access/apps/agent-app/policies/agent-policy",
    );
    expect(putRequests(fake)).toEqual([
      "PUT /accounts/test-account/access/apps/agent-app/policies/agent-policy",
    ]);
    const body = fake.policyPuts[0]!.body as Record<string, any>;
    expect(body.precedence).toBe(1);
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("reusable");
  });

  it("proves the old application-level PUT rejects reusable policies", async () => {
    const response = await fetch(
      "http://127.0.0.1:8788/client/v4/accounts/test-account/access/apps/agent-app/policies/agent-policy",
      {
        method: "PUT",
        headers: {
          authorization: "Bearer test-api-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ include: [] }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.errors[0].message).toContain(
      "can not update reusable policies through this endpoint",
    );
  });

  it("rejects invalid application/policy binding, decision, account, and reusable scope before PUT", async () => {
    const cases: Array<{
      name: string;
      setup: () => void;
      error: RegExp;
    }> = [
      {
        name: "application id mismatch",
        setup: () => {
          fake.appIds["agent-app"] = "different-app";
        },
        error: /returned a different id/,
      },
      {
        name: "policy not attached to application",
        setup: () => {
          fake.appPolicies["agent-app"] = [];
        },
        error: /does not contain policy/,
      },
      {
        name: "policy response id mismatch",
        setup: () => {
          fake.policies["agent-policy"]!.id = "different-policy";
        },
        error: /response id does not match/,
      },
      {
        name: "wrong decision",
        setup: () => {
          fake.policies["agent-policy"]!.decision = "allow";
        },
        error: /non_identity/,
      },
      {
        name: "wrong account",
        setup: () => {
          fake.policies["agent-policy"]!.account_id = "other-account";
        },
        error: /different account/,
      },
      {
        name: "shared reusable policy",
        setup: () => {
          fake.policies["agent-policy"]!.app_count = 2;
        },
        error: /exactly one application/,
      },
      {
        name: "missing app_count",
        setup: () => {
          delete fake.policies["agent-policy"]!.app_count;
        },
        error: /missing app_count/,
      },
      {
        name: "legacy endpoint returned a reusable policy",
        setup: () => {
          fake.legacyPolicyIds.add("agent-policy");
          fake.policies["agent-policy"]!.reusable = true;
        },
        error: /refusing to update it through the legacy endpoint/,
      },
    ];

    for (const item of cases) {
      fake = installFakeCloudflare();
      item.setup();
      await expect(
        api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token"),
      ).rejects.toThrow(item.error);
      expect(fake.policyPuts, item.name).toHaveLength(0);
    }
  });

  it("does not fall back or retry on 403, 429, 500, or network failure", async () => {
    for (const failure of [
      { status: 403 },
      { status: 429 },
      { status: 500 },
      { network: true },
    ]) {
      fake = installFakeCloudflare();
      fake.accountPolicyGetFailure = failure;
      await expect(
        api().addServiceTokenToPolicy("agent-app", "agent-policy", "new-token"),
      ).rejects.toThrow(/Cloudflare API/);
      expect(
        fake.requests.filter((request) =>
          request.includes("/access/apps/agent-app/policies/agent-policy"),
        ),
      ).toHaveLength(0);
      expect(
        fake.requests.filter((request) =>
          request.startsWith("GET /accounts/test-account/access/policies/agent-policy"),
        ),
      ).toHaveLength(1);
      expect(fake.policyPuts).toHaveLength(0);
    }
  });
});

describe("provisioning uses the account-level reusable policy path", () => {
  let fake: FakeCloudflareState;
  beforeEach(async () => {
    await reset();
    fake = installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("creates and revokes an enrollment through the enroll account policy", async () => {
    const { requestId, response } = await createEnrollment(fake);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const token = fake.tokens.find((candidate) => candidate.name === `ecp-e-${requestId}`);
    expect(token).toBeTruthy();
    expect(policyTokens(fake.policies["enroll-policy"])).toContain(token!.id);

    const revoke = await uiCall(`/ui-api/enrollments/${body.enrollment.id}/revoke`, {
      method: "POST",
    });
    expect(revoke.status).toBe(200);
    expect(policyTokens(fake.policies["enroll-policy"])).not.toContain(token!.id);
    expect(putRequests(fake).length).toBeGreaterThanOrEqual(2);
    for (const request of putRequests(fake)) {
      expect(request).toBe("PUT /accounts/test-account/access/policies/enroll-policy");
    }
  });

  it("creates, rotates, and disables an Agent through the agent account policy", async () => {
    const { agent } = await createAgent(fake, "alpha");
    expect(putRequests(fake)).toEqual([
      "PUT /accounts/test-account/access/policies/agent-policy",
    ]);

    fake.policyPuts.length = 0;
    fake.requests.length = 0;
    expect((await uiCall(`/ui-api/agents/${agent.id}/rotate`, { method: "POST" })).status).toBe(200);
    expect(putRequests(fake).length).toBeGreaterThanOrEqual(1);
    for (const request of putRequests(fake)) {
      expect(request).toBe("PUT /accounts/test-account/access/policies/agent-policy");
    }

    fake.policyPuts.length = 0;
    fake.requests.length = 0;
    expect((await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" })).status).toBe(200);
    expect(putRequests(fake)).toEqual([
      "PUT /accounts/test-account/access/policies/agent-policy",
    ]);
  });

  it("rolls back a failed enrollment on the enroll policy, never the agent policy", async () => {
    fake.failNextPolicyPutAfterApplyFor = "enroll-policy";
    const { requestId, response } = await createEnrollment(fake);
    expect(response.status).toBe(502);

    const added = fake.policyPuts[0]!.body.include as any[];
    const addedToken = added.find(
      (rule) => rule?.service_token?.token_id && rule.service_token.token_id !== "unmanaged-enroll",
    )?.service_token?.token_id;
    expect(addedToken).toBeTruthy();
    expect(fake.tokens.find((token) => token.name === `ecp-e-${requestId}`)).toBeUndefined();
    expect(policyTokens(fake.policies["enroll-policy"])).toEqual(["unmanaged-enroll"]);
    expect(policyTokens(fake.policies["agent-policy"])).toEqual(["unmanaged-token"]);
    expect(putRequests(fake).length).toBeGreaterThanOrEqual(2);
    for (const request of putRequests(fake)) {
      expect(request).toBe("PUT /accounts/test-account/access/policies/enroll-policy");
    }
    const list = (await (await uiCall("/ui-api/enrollments")).json()) as any;
    expect(list.enrollments).toHaveLength(0);
  });
});
