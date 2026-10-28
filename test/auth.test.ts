import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiToken,
  call,
  installFakeCloudflare,
  restoreFetch,
  signAccessJwt,
  uiCall,
  uiToken,
} from "./helpers";
import { TEST_AUD, TEST_PUBLIC_URL } from "./fixtures";

describe("One Access authentication and browser CSRF", () => {
  beforeEach(async () => {
    await reset();
    installFakeCloudflare();
  });
  afterEach(() => restoreFetch());

  it("returns session identity for a valid UI JWT", async () => {
    const response = await uiCall("/ui-api/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      identity: "admin@example.com",
    });
  });

  it("rejects missing, malformed, expired and wrong-audience JWTs", async () => {
    expect((await call("/ui-api/agents", { token: null })).status).toBe(401);
    expect((await call("/ui-api/agents", { token: "not-a-jwt" })).status).toBe(401);
    const expired = await signAccessJwt({
      aud: TEST_AUD.ui,
      email: "admin@example.com",
      exp: Math.floor(Date.now() / 1000) - 120,
    });
    expect((await call("/ui-api/agents", { token: expired })).status).toBe(401);
    const wrongAud = await apiToken("api-client");
    expect((await call("/ui-api/agents", { token: wrongAud })).status).toBe(401);
    const device = await signAccessJwt({
      aud: TEST_AUD.agent,
      commonName: "client-device",
      sub: "",
    });
    expect((await call("/api/v1/agents", { token: device })).status).toBe(401);
  });

  it("enforces same-origin on UI writes but allows ServiceAuth automation writes", async () => {
    const token = await uiToken();
    const missing = await call("/ui-api/groups", {
      method: "POST",
      token,
      body: { name: "no-origin" },
    });
    expect(missing.status).toBe(403);
    const cross = await call("/ui-api/groups", {
      method: "POST",
      token,
      origin: "https://evil.example",
      body: { name: "cross-origin" },
    });
    expect(cross.status).toBe(403);
    const apiService = await apiToken("api-client");
    const apiWrite = await call("/api/v1/groups", {
      method: "POST",
      token: apiService,
      body: { name: "automation" },
    });
    expect(apiWrite.status).toBe(201);
    const apiSession = await call("/api/v1/session", { token: apiService });
    expect(apiSession.status).toBe(404);
    const wrongService = await call("/api/v1/agents", {
      token: await apiToken("another-service"),
    });
    expect(wrongService.status).toBe(403);
  });

  it("pins the public host and protects static assets with the UI app", async () => {
    const token = await uiToken();
    const wrongHost = await call("/ui-api/agents", {
      token,
      url: "https://evil.example/ui-api/agents",
    });
    expect(wrongHost.status).toBe(421);
    const staticNoAuth = await call("/");
    expect(staticNoAuth.status).toBe(401);
    const staticAuth = await call("/", { token });
    expect(staticAuth.status).toBe(200);
    expect(await staticAuth.text()).toContain("Edge Command");
  });

  it("does not accept Origin alone as authentication for browser websocket", async () => {
    const response = await call("/events/ws", {
      token: null,
      origin: TEST_PUBLIC_URL,
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });
});
