import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import {
  agentToken,
  call,
  createAgent,
  installFakeCloudflare,
  restoreFetch,
  uiCall,
} from "./helpers";
import type { FakeCloudflareState } from "./helpers";

function policyTokens(policy: any): string[] {
  return (policy.include as any[])
    .filter((rule) => rule?.service_token?.token_id)
    .map((rule) => rule.service_token.token_id);
}

describe("Cloudflare Access automatic provisioning", () => {
  let fake: FakeCloudflareState;
  beforeEach(async () => {
    await reset();
    fake = installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("creates a token, actually authorizes it in the device policy, and encrypts the secret", async () => {
    const { agent, token, requestId } = await createAgent(fake, "alpha");
    expect(agent.name).toBe("alpha");
    expect(agent.online).toBe(false);
    expect(agent.disabled).toBe(false);
    expect(fake.tokens).toHaveLength(1);
    expect(token.duration).toBe("8760h");
    expect(fake.policies["agent-policy"]!.include).toContainEqual({
      service_token: { token_id: token.id },
    });
    expect(fake.policies["agent-policy"]!.include).toContainEqual({
      email: { email: "ops@example.com" },
    });
    expect(fake.policies["agent-policy"]!.exclude).toEqual([{ ip: { ip: "203.0.113.9" } }]);

    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    const stored = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<Record<string, string>>("SELECT token_cipher FROM agents WHERE id=?", agent.id)
        .one();
      return row.token_cipher;
    });
    expect(stored).not.toContain(token.client_secret);
    expect(stored).toMatch(/^v1\./);

    const installA = await uiCall(`/ui-api/agents/${agent.id}/install`);
    expect(installA.status).toBe(200);
    expect(installA.headers.get("cache-control")).toBe("no-store");
    const info = (await installA.json()) as any;
    expect(info.command).toContain(token.client_id);
    expect(info.command).toContain(token.client_secret);
    expect(info.command).toContain("bash -o pipefail -c");
    expect(info.command).not.toContain("| bash");
    expect(info.script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(info.script).toContain("export ECP_CLIENT_SECRET=");
    expect(info.script).toContain(`export ECP_AGENT_ID=`);
    expect(info.link).toBe(`http://localhost:8787/install#${info.link.split("#")[1]}`);

    const installB = await uiCall(`/ui-api/agents/${agent.id}/install`);
    const infoB = (await installB.json()) as any;
    expect(infoB.command).toBe(info.command);
    expect(fake.tokens).toHaveLength(1);

    const same = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "alpha" },
    });
    expect(same.status).toBe(200);
    expect(fake.tokens).toHaveLength(1);
    const conflict = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "different" },
    });
    expect(conflict.status).toBe(409);
  });

  it("rolls back a token when policy authorization fails", async () => {
    fake.failPolicyPut = true;
    const requestId = crypto.randomUUID();
    const response = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "broken" },
    });
    expect(response.status).toBe(502);
    expect(fake.tokens).toHaveLength(0);
    expect(policyTokens(fake.policies["agent-policy"]!)).toEqual(["unmanaged-token"]);
    const agents = (await (await uiCall("/ui-api/agents")).json()) as any;
    expect(agents.agents).toHaveLength(0);
  });

  it("rejects at the 50-token account limit", async () => {
    for (let i = 0; i < 50; i++) {
      fake.tokens.push({
        id: `existing-${i}`,
        name: `existing-${i}`,
        client_id: `existing-client-${i}`,
        client_secret: "x",
      });
    }
    const response = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId: crypto.randomUUID(), name: "too-many" },
    });
    expect(response.status).toBe(502);
    expect(fake.tokens).toHaveLength(50);
    expect((await (await uiCall("/ui-api/agents")).json() as any).agents).toHaveLength(0);
  });

  it("rotates credentials, preserves unmanaged policy rules, and invalidates the old install info", async () => {
    const { agent, token } = await createAgent(fake, "rotate-me");
    const response = await uiCall(`/ui-api/agents/${agent.id}/rotate`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(fake.tokens).toHaveLength(1);
    const newToken = fake.tokens[0]!;
    expect(newToken.id).not.toBe(token.id);
    const authorized = policyTokens(fake.policies["agent-policy"]!);
    expect(authorized).not.toContain(token.id);
    expect(authorized).toContain(newToken.id);
    expect(authorized).toContain("unmanaged-token");
    const install = (await (await uiCall(`/ui-api/agents/${agent.id}/install`)).json()) as any;
    expect(install.command).toContain(newToken.client_id);
    expect(install.command).not.toContain(token.client_id);
  });

  it("serializes concurrent provisioning and never creates two tokens for one requestId", async () => {
    const agents = await Promise.all([
      uiCall("/ui-api/agents", {
        method: "POST",
        body: { requestId: crypto.randomUUID(), name: "concurrent-a" },
      }),
      uiCall("/ui-api/agents", {
        method: "POST",
        body: { requestId: crypto.randomUUID(), name: "concurrent-b" },
      }),
    ]);
    expect(agents.map((r) => r.status)).toEqual([200, 200]);
    expect(fake.tokens).toHaveLength(2);
    const authorized = policyTokens(fake.policies["agent-policy"]!);
    for (const token of fake.tokens) expect(authorized).toContain(token.id);

    const requestId = crypto.randomUUID();
    const same = await Promise.all([
      uiCall("/ui-api/agents", {
        method: "POST",
        body: { requestId, name: "same-a" },
      }),
      uiCall("/ui-api/agents", {
        method: "POST",
        body: { requestId, name: "same-a" },
      }),
    ]);
    expect(same.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const bodies = await Promise.all(
      same.map(async (r) => (r.status === 200 ? ((await r.json()) as any).agent.id : null)),
    );
    expect(new Set(bodies.filter(Boolean)).size).toBe(1);
    expect(fake.tokens).toHaveLength(3);
  });

  it("keeps local disable effective when Cloudflare cleanup fails, and retries it", async () => {
    const { agent, token } = await createAgent(fake, "cleanup-retry");
    fake.failPolicyPut = true;
    const failed = await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" });
    expect(failed.status).toBe(502);
    expect(fake.tokens.map((t) => t.id)).toContain(token.id);
    const listed = (await (await uiCall("/ui-api/agents")).json()) as any;
    expect(listed.agents[0].disabled).toBe(true);
    expect(listed.agents[0].online).toBe(false);

    fake.failPolicyPut = false;
    const retried = await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(fake.tokens.map((t) => t.id)).not.toContain(token.id);
    expect(policyTokens(fake.policies["agent-policy"]!)).not.toContain(token.id);
  });

  it("recovers a lost create response by deleting only the intent-owned orphan", async () => {
    const requestId = crypto.randomUUID();
    const tokenName = `ecp-a-${requestId}`;
    fake.dropNextCreateResponse = true;
    const first = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "lost-create" },
    });
    expect(first.status).toBe(502);
    const orphan = fake.tokens.find((t) => t.name === tokenName)!;
    expect(orphan).toBeTruthy();
    expect(orphan.client_secret).toBeTruthy();
    const external = {
      id: "external-similar-id",
      name: `${tokenName}-external`,
      client_id: "external-similar-client",
      client_secret: "external-secret",
    };
    fake.tokens.push(external);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: external.id },
    });

    // The real Cloudflare One list response never includes client_secret.
    const listed = await fetch(
      "http://127.0.0.1:8788/client/v4/accounts/test-account/access/service_tokens",
      { headers: { authorization: "Bearer test-api-token" } },
    );
    const listedBody = (await listed.json()) as any;
    expect(listedBody.result.find((t: any) => t.id === orphan.id).client_secret).toBeUndefined();

    const retry = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "lost-create" },
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as any;
    expect(fake.tokens.find((t) => t.id === orphan.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    const replacement = fake.tokens.find((t) => t.name === tokenName)!;
    expect(replacement).toBeTruthy();
    expect(replacement.id).not.toBe(orphan.id);
    const authorized = policyTokens(fake.policies["agent-policy"]!);
    expect(authorized).not.toContain(orphan.id);
    expect(authorized).toContain(replacement.id);
    expect(authorized).toContain(external.id);
    const install = (await (await uiCall(`/ui-api/agents/${retryBody.agent.id}/install`)).json()) as any;
    expect(install.command).toContain(replacement.client_secret);
  });

  it("reuses a bound agent credential from AES storage after a provision record regression", async () => {
    const { agent, token, requestId } = await createAgent(fake, "bound-recovery");
    const before = (await (await uiCall(`/ui-api/agents/${agent.id}/install`)).json()) as any;
    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE provision_requests SET status='failed' WHERE request_id=?",
        requestId,
      );
    });
    const retry = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "bound-recovery" },
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as any;
    expect(retryBody.agent.id).toBe(agent.id);
    expect(fake.tokens).toHaveLength(1);
    expect(fake.tokens[0]!.id).toBe(token.id);
    const after = (await (await uiCall(`/ui-api/agents/${agent.id}/install`)).json()) as any;
    expect(after.command).toBe(before.command);
  });

  it("cleans a previous rotated token left by an interruption before starting the next rotation", async () => {
    const { agent, token } = await createAgent(fake, "rotate-window");
    const interrupted = {
      id: "interrupted-new-token",
      name: "ecp-r-interrupted",
      client_id: "interrupted-new-client",
      client_secret: "interrupted-new-secret",
    };
    fake.tokens.push(interrupted);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: interrupted.id },
    });
    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agents SET access_client_id=?,access_token_id=?,previous_token_id=? WHERE id=?",
        interrupted.client_id,
        interrupted.id,
        token.id,
        agent.id,
      );
    });
    const rotated = await uiCall(`/ui-api/agents/${agent.id}/rotate`, { method: "POST" });
    expect(rotated.status).toBe(200);
    expect(fake.tokens.find((t) => t.id === token.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === interrupted.id)).toBeUndefined();
    expect(fake.tokens).toHaveLength(1);
    const current = fake.tokens[0]!;
    const authorized = policyTokens(fake.policies["agent-policy"]!);
    expect(authorized).not.toContain(token.id);
    expect(authorized).not.toContain(interrupted.id);
    expect(authorized).toContain(current.id);
  });

  it("recovers a lost rotate create response via the stable rotate intent", async () => {
    const { agent, token } = await createAgent(fake, "rotate-recovery");
    const external = {
      id: "external-rotate-id",
      name: "ecp-r-lookalike",
      client_id: "external-rotate-client",
      client_secret: "external-rotate-secret",
    };
    fake.tokens.push(external);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: external.id },
    });
    fake.dropNextCreateResponse = true;
    const first = await uiCall(`/ui-api/agents/${agent.id}/rotate`, { method: "POST" });
    expect(first.status).toBe(502);
    const orphan = fake.tokens.find(
      (t) => t.name.startsWith("ecp-r-") && t.id !== external.id,
    )!;
    expect(orphan).toBeTruthy();
    const retry = await uiCall(`/ui-api/agents/${agent.id}/rotate`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect(fake.tokens.find((t) => t.id === orphan.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === token.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    const replacement = fake.tokens.find(
      (t) => t.name.startsWith("ecp-r-") && t.id !== external.id,
    )!;
    expect(replacement).toBeTruthy();
    const authorized = policyTokens(fake.policies["agent-policy"]!);
    expect(authorized).not.toContain(orphan.id);
    expect(authorized).not.toContain(token.id);
    expect(authorized).toContain(replacement.id);
    expect(authorized).toContain(external.id);
    const install = (await (await uiCall(`/ui-api/agents/${agent.id}/install`)).json()) as any;
    expect(install.command).toContain(replacement.client_secret);
  });

  it("does not delete an unmanaged token even when its name exactly matches a fresh request id", async () => {
    const requestId = crypto.randomUUID();
    const external = {
      id: "external-exact-id",
      name: `ecp-a-${requestId}`,
      client_id: "external-exact-client",
      client_secret: "external-exact-secret",
    };
    fake.tokens.push(external);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: external.id },
    });
    const response = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "must-not-steal" },
    });
    expect(response.status).toBe(502);
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    expect(policyTokens(fake.policies["agent-policy"]!)).toContain(external.id);
    expect(((await (await uiCall("/ui-api/agents")).json()) as any).agents).toHaveLength(0);
    const retry = await uiCall("/ui-api/agents", {
      method: "POST",
      body: { requestId, name: "must-not-steal" },
    });
    expect(retry.status).toBe(502);
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    expect(policyTokens(fake.policies["agent-policy"]!)).toContain(external.id);
  });

  it("does not delete an external token merely because its name is similar", async () => {
    const external = {
      id: "external-only-id",
      name: "ecp-a-lookalike",
      client_id: "external-only-client",
      client_secret: "external-only-secret",
    };
    fake.tokens.push(external);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: external.id },
    });
    const { agent } = await createAgent(fake, "external-safe");
    expect(agent.id).toBeTruthy();
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    expect(policyTokens(fake.policies["agent-policy"]!)).toContain(external.id);
  });

  it("serves agent install/download only with a matching device identity", async () => {
    const { agent, token } = await createAgent(fake, "install-me");
    const deviceJwt = await agentToken(token.client_id);
    const script = await call("/agent/install.sh", { token: deviceJwt });
    expect(script.status).toBe(200);
    expect(await script.text()).toMatch(/^#!/);
    const binary = await call("/agent/download/amd64", { token: deviceJwt });
    expect([200, 503]).toContain(binary.status);
    if (binary.status === 200) {
      expect(binary.headers.get("content-type")).toBe("application/octet-stream");
      expect(binary.headers.get("content-disposition")).toContain("edge-agent-linux-amd64");
    }
    const wrongDevice = await call("/agent/install.sh", {
      token: await agentToken("client-not-registered"),
    });
    expect(wrongDevice.status).toBe(403);
    const disabled = await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" });
    expect(disabled.status).toBe(200);
    expect(fake.tokens).toHaveLength(0);
    expect(policyTokens(fake.policies["agent-policy"]!)).not.toContain(token.id);
    const afterDisable = await call("/agent/install.sh", { token: deviceJwt });
    expect(afterDisable.status).toBe(403);
    // Retriable idempotent disable does not report false cloud success.
    expect((await uiCall(`/ui-api/agents/${agent.id}/disable`, { method: "POST" })).status).toBe(200);
  });
});
