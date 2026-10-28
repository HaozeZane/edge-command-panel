import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import {
  b64,
  call,
  createAgent,
  enrollToken,
  installFakeCloudflare,
  restoreFetch,
  uiCall,
} from "./helpers";
import type { FakeCloudflareState } from "./helpers";

async function newKeyPair(): Promise<{ publicKey: string; sign: (text: string) => Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: b64(raw),
    async sign(text: string) {
      const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(text));
      return b64(new Uint8Array(signature));
    },
  };
}

function canonical(challenge: string, installationId: string, hostname: string, publicKey: string) {
  return ["ECP-ENROLL-V1", challenge, installationId, hostname, publicKey].join("\n");
}

async function createEnrollment(
  fake: FakeCloudflareState,
  maxAgents = 3,
  ttlMinutes = 30,
): Promise<{ enrollment: any; enrollmentTokenId: string; requestId: string }> {
  const requestId = crypto.randomUUID();
  const response = await uiCall("/ui-api/enrollments", {
    method: "POST",
    body: { requestId, name: "site-a", groupIds: [], maxAgents, ttlMinutes },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  const token = fake.tokens.find((t) => t.name === `ecp-e-${requestId}`);
  expect(token).toBeTruthy();
  expect(token!.duration).toBe(`${ttlMinutes + 60}m`);
  expect(body.install.command).toContain("/enroll/install.sh");
  expect(body.install.script).toContain("export ECP_MODE=");
  expect(body.install.script).toContain("enroll");
  return { enrollment: body.enrollment, enrollmentTokenId: token!.client_id, requestId };
}

async function challenge(
  enrollmentClientId: string,
  installationId: string,
  publicKey: string,
): Promise<{ challenge: string; expiresAt: number }> {
  const response = await call("/enroll/challenge", {
    method: "POST",
    token: await enrollToken(enrollmentClientId),
    body: { installationId, publicKey },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { challenge: string; expiresAt: number };
}

async function register(
  enrollmentClientId: string,
  input: {
    installationId: string;
    hostname: string;
    publicKey: string;
    challenge: string;
    signature: string;
  },
): Promise<Response> {
  return call("/enroll/register", {
    method: "POST",
    token: await enrollToken(enrollmentClientId),
    body: input,
  });
}

describe("batch enrollment with Ed25519 proof of possession", () => {
  let fake: FakeCloudflareState;
  beforeEach(async () => {
    await reset();
    fake = installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("registers once, then reuses the same per-device token on a fresh challenge", async () => {
    const { enrollment, enrollmentTokenId } = await createEnrollment(fake);
    const keys = await newKeyPair();
    const installationId = crypto.randomUUID();
    const hostname = "host-a";
    const firstChallenge = await challenge(enrollmentTokenId, installationId, keys.publicKey);
    const signature = await keys.sign(
      canonical(firstChallenge.challenge, installationId, hostname, keys.publicKey),
    );
    const first = await register(enrollmentTokenId, {
      installationId,
      hostname,
      publicKey: keys.publicKey,
      challenge: firstChallenge.challenge,
      signature,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.url).toBe("http://localhost:8787/agent/ws");
    expect(fake.tokens).toHaveLength(2);
    const firstToken = fake.tokens.find((t) => t.client_id === firstBody.clientId)!;
    expect(firstToken).toBeTruthy();
    expect(fake.policies["agent-policy"]!.include).toContainEqual({
      service_token: { token_id: firstToken.id },
    });

    const replay = await register(enrollmentTokenId, {
      installationId,
      hostname,
      publicKey: keys.publicKey,
      challenge: firstChallenge.challenge,
      signature,
    });
    expect(replay.status).toBe(400);

    const secondChallenge = await challenge(enrollmentTokenId, installationId, keys.publicKey);
    const secondSignature = await keys.sign(
      canonical(secondChallenge.challenge, installationId, hostname, keys.publicKey),
    );
    const second = await register(enrollmentTokenId, {
      installationId,
      hostname,
      publicKey: keys.publicKey,
      challenge: secondChallenge.challenge,
      signature: secondSignature,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as any;
    expect(secondBody.agentId).toBe(firstBody.agentId);
    expect(secondBody.clientId).toBe(firstBody.clientId);
    expect(secondBody.clientSecret).toBe(firstBody.clientSecret);
    expect(fake.tokens).toHaveLength(2);

    const list = (await (await uiCall("/ui-api/enrollments")).json()) as any;
    expect(list.enrollments[0].registeredCount).toBe(1);
    expect(list.enrollments[0].maxAgents).toBe(enrollment.maxAgents);
  });

  it("allows duplicate hostnames but a new installation gets a new token", async () => {
    const { enrollmentTokenId } = await createEnrollment(fake, 2);
    for (let i = 0; i < 2; i++) {
      const keys = await newKeyPair();
      const installationId = crypto.randomUUID();
      const hostname = "same-host";
      const c = await challenge(enrollmentTokenId, installationId, keys.publicKey);
      const response = await register(enrollmentTokenId, {
        installationId,
        hostname,
        publicKey: keys.publicKey,
        challenge: c.challenge,
        signature: await keys.sign(canonical(c.challenge, installationId, hostname, keys.publicKey)),
      });
      expect(response.status).toBe(200);
    }
    expect(fake.tokens).toHaveLength(3);
    const agents = (await (await uiCall("/ui-api/agents")).json()) as any;
    expect(agents.agents.map((a: any) => a.name)).toEqual(["same-host", "same-host"]);
  });

  it("rejects maxAgents, wrong key, expired/revoked enrollment and revoked token principals", async () => {
    const { enrollment, enrollmentTokenId } = await createEnrollment(fake, 1);
    const keyA = await newKeyPair();
    const installationA = crypto.randomUUID();
    const c1 = await challenge(enrollmentTokenId, installationA, keyA.publicKey);
    expect(
      (
        await register(enrollmentTokenId, {
          installationId: installationA,
          hostname: "a",
          publicKey: keyA.publicKey,
          challenge: c1.challenge,
          signature: await keyA.sign(canonical(c1.challenge, installationA, "a", keyA.publicKey)),
        })
      ).status,
    ).toBe(200);

    const keyB = await newKeyPair();
    const installationB = crypto.randomUUID();
    const c2 = await challenge(enrollmentTokenId, installationB, keyB.publicKey);
    const overLimit = await register(enrollmentTokenId, {
      installationId: installationB,
      hostname: "b",
      publicKey: keyB.publicKey,
      challenge: c2.challenge,
      signature: await keyB.sign(canonical(c2.challenge, installationB, "b", keyB.publicKey)),
    });
    expect(overLimit.status).toBe(409);

    const c3 = await challenge(enrollmentTokenId, installationA, keyA.publicKey);
    const wrongKey = await register(enrollmentTokenId, {
      installationId: installationA,
      hostname: "a",
      publicKey: keyB.publicKey,
      challenge: c3.challenge,
      signature: await keyB.sign(canonical(c3.challenge, installationA, "a", keyB.publicKey)),
    });
    expect(wrongKey.status).toBe(400);

    const revoke = await uiCall(`/ui-api/enrollments/${enrollment.id}/revoke`, { method: "POST" });
    expect(revoke.status).toBe(200);
    expect(fake.tokens.map((t) => t.name)).not.toContain(`ecp-e-${enrollment.requestId}`);
    expect(fake.policies["enroll-policy"]!.include).not.toContainEqual({
      service_token: { token_id: enrollment.accessTokenId },
    });
    expect((await uiCall(`/ui-api/enrollments/${enrollment.id}/revoke`, { method: "POST" })).status).toBe(200);
    const afterRevoke = await call("/enroll/challenge", {
      method: "POST",
      token: await enrollToken(enrollmentTokenId),
      body: { installationId: crypto.randomUUID(), publicKey: keyA.publicKey },
    });
    expect(afterRevoke.status).toBe(410);
  });

  it("keeps revoke local when Cloudflare cleanup fails, and retries without false success", async () => {
    const { enrollment, enrollmentTokenId } = await createEnrollment(fake);
    fake.failPolicyPut = true;
    const failed = await uiCall(`/ui-api/enrollments/${enrollment.id}/revoke`, { method: "POST" });
    expect(failed.status).toBe(502);
    const stillThere = fake.tokens.find((t) => t.client_id === enrollmentTokenId);
    expect(stillThere).toBeTruthy();
    const list = (await (await uiCall("/ui-api/enrollments")).json()) as any;
    expect(list.enrollments[0].revoked).toBe(true);
    const blocked = await call("/enroll/challenge", {
      method: "POST",
      token: await enrollToken(enrollmentTokenId),
      body: { installationId: "x", publicKey: (await newKeyPair()).publicKey },
    });
    expect(blocked.status).toBe(410);

    fake.failPolicyPut = false;
    const retried = await uiCall(`/ui-api/enrollments/${enrollment.id}/revoke`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(fake.tokens.find((t) => t.client_id === enrollmentTokenId)).toBeUndefined();
    expect(fake.policies["enroll-policy"]!.include).not.toContainEqual({
      service_token: { token_id: stillThere!.id },
    });
  });

  it("reclaims only this project's expired enrollment tokens on the daily Alarm", async () => {
    const { enrollment, enrollmentTokenId } = await createEnrollment(fake, 2, 5);
    const enrollmentToken = fake.tokens.find((t) => t.client_id === enrollmentTokenId)!;
    const unrelated = {
      id: "other-account-token",
      name: "someone-else",
      client_id: "other-client",
      client_secret: "x",
    };
    fake.tokens.push(unrelated);
    fake.policies["enroll-policy"]!.include.push({
      service_token: { token_id: unrelated.id },
    });
    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE enrollments SET expires_at=? WHERE id=?",
        Date.now() - 1000,
        enrollment.id,
      );
      state.storage.sql.exec("UPDATE meta SET value='0' WHERE key='next_cleanup_at'");
      await (instance as any).alarm();
    });
    expect(fake.tokens.find((t) => t.client_id === enrollmentTokenId)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === unrelated.id)).toBeTruthy();
    expect(fake.policies["enroll-policy"]!.include).toContainEqual({
      service_token: { token_id: unrelated.id },
    });
  });

  it("recovers a lost enrollment-token create response without touching lookalike tokens", async () => {
    const requestId = crypto.randomUUID();
    const payload = {
      requestId,
      name: "lost-enrollment",
      groupIds: [],
      maxAgents: 2,
      ttlMinutes: 10,
    };
    fake.dropNextCreateResponse = true;
    const first = await uiCall("/ui-api/enrollments", { method: "POST", body: payload });
    expect(first.status).toBe(502);
    const orphan = fake.tokens.find((t) => t.name === `ecp-e-${requestId}`)!;
    expect(orphan).toBeTruthy();
    const external = {
      id: "external-enroll-id",
      name: `ecp-e-${requestId}-external`,
      client_id: "external-enroll-client",
      client_secret: "external-enroll-secret",
    };
    fake.tokens.push(external);
    fake.policies["enroll-policy"]!.include.push({
      service_token: { token_id: external.id },
    });

    const retry = await uiCall("/ui-api/enrollments", { method: "POST", body: payload });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as any;
    expect(body.enrollment.name).toBe("lost-enrollment");
    const replacement = fake.tokens.find((t) => t.name === `ecp-e-${requestId}`)!;
    expect(replacement).toBeTruthy();
    expect(replacement.id).not.toBe(orphan.id);
    expect(fake.tokens.find((t) => t.id === orphan.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    const authorized = (fake.policies["enroll-policy"]!.include as any[])
      .filter((rule) => rule?.service_token?.token_id)
      .map((rule) => rule.service_token.token_id);
    expect(authorized).not.toContain(orphan.id);
    expect(authorized).toContain(replacement.id);
    expect(authorized).toContain(external.id);
    expect(body.install.command).toContain(replacement.client_secret);
  });

  it("reuses a bound enrollment credential from AES storage when the provision record regressed", async () => {
    const { enrollment, requestId } = await createEnrollment(fake, 2, 5);
    const before = (await (await uiCall(`/ui-api/enrollments/${enrollment.id}/install`)).json()) as any;
    const stub = (env as any).HUB.get((env as any).HUB.idFromName("hub"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE provision_requests SET status='failed' WHERE request_id=?",
        requestId,
      );
    });
    const retry = await uiCall("/ui-api/enrollments", {
      method: "POST",
      body: { requestId, name: "site-a", groupIds: [], maxAgents: 2, ttlMinutes: 5 },
    });
    expect(retry.status).toBe(200);
    const after = (await retry.json()) as any;
    expect(after.enrollment.id).toBe(enrollment.id);
    expect(fake.tokens).toHaveLength(1);
    expect(after.install.command).toBe(before.command);
  });

  it("recovers a lost registration create response via a stable persisted registration intent", async () => {
    const { enrollmentTokenId } = await createEnrollment(fake, 2, 10);
    const keys = await newKeyPair();
    const installationId = crypto.randomUUID();
    const hostname = "lost-register";
    const c = await challenge(enrollmentTokenId, installationId, keys.publicKey);
    const signature = await keys.sign(canonical(c.challenge, installationId, hostname, keys.publicKey));
    fake.dropNextCreateResponse = true;
    const first = await register(enrollmentTokenId, {
      installationId,
      hostname,
      publicKey: keys.publicKey,
      challenge: c.challenge,
      signature,
    });
    expect(first.status).toBe(502);
    const orphan = fake.tokens.find((t) => t.name.startsWith("ecp-n-"))!;
    expect(orphan).toBeTruthy();
    expect(orphan.client_secret).toBeTruthy();
    const external = {
      id: "external-register-id",
      name: `${orphan.name}-external`,
      client_id: "external-register-client",
      client_secret: "external-register-secret",
    };
    fake.tokens.push(external);
    fake.policies["agent-policy"]!.include.push({
      service_token: { token_id: external.id },
    });

    // The client can retry the same still-unused challenge after a transport failure.
    const retry = await register(enrollmentTokenId, {
      installationId,
      hostname,
      publicKey: keys.publicKey,
      challenge: c.challenge,
      signature,
    });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as any;
    expect(body.clientId).not.toBe(orphan.client_id);
    expect(fake.tokens.find((t) => t.id === orphan.id)).toBeUndefined();
    expect(fake.tokens.find((t) => t.id === external.id)).toBeTruthy();
    const replacement = fake.tokens.find(
      (t) => t.client_id === body.clientId && t.name.startsWith("ecp-n-"),
    )!;
    expect(replacement).toBeTruthy();
    const authorized = (fake.policies["agent-policy"]!.include as any[])
      .filter((rule) => rule?.service_token?.token_id)
      .map((rule) => rule.service_token.token_id);
    expect(authorized).not.toContain(orphan.id);
    expect(authorized).toContain(replacement.id);
    expect(authorized).toContain(external.id);
    const list = (await (await uiCall("/ui-api/enrollments")).json()) as any;
    expect(list.enrollments[0].registeredCount).toBe(1);
  });

  it("binds common_name to the enrollment client and rejects device/admin JWTs", async () => {
    const { enrollmentTokenId } = await createEnrollment(fake);
    const wrong = await call("/enroll/challenge", {
      method: "POST",
      token: await enrollToken("unknown-client"),
      body: { installationId: "x", publicKey: (await newKeyPair()).publicKey },
    });
    expect(wrong.status).toBe(403);
    const deviceJwt = await enrollToken(enrollmentTokenId);
    expect((await call("/ui-api/agents", { token: deviceJwt })).status).toBe(401);
    expect((await call("/api/v1/agents", { token: deviceJwt })).status).toBe(401);
  });
});
