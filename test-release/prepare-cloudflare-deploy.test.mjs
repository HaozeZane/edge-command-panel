import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PUBLIC_URL,
  parseJsonc,
  prepareCloudflareDeploy,
} from "../scripts/prepare-cloudflare-deploy.mjs";

const TMP_ROOT = fileURLToPath(new URL("../.paseo-scratch/test-tmp/", import.meta.url));
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const MANAGEMENT_TOKEN = "runtime-management-token";
const DEPLOY_TOKEN = "deploy-only-token-value";

function baseEnv() {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    PUBLIC_URL: "https://panel.example.com",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_UI_AUD: "aud-ui",
    ACCESS_API_AUD: "aud-api",
    ACCESS_AGENT_AUD: "aud-agent",
    ACCESS_ENROLL_AUD: "aud-enroll",
    AGENT_ACCESS_APP_ID: "agent-app-id",
    AGENT_ACCESS_POLICY_ID: "agent-policy-id",
    ENROLL_ACCESS_APP_ID: "enroll-app-id",
    ENROLL_ACCESS_POLICY_ID: "enroll-policy-id",
    CF_ACCESS_MANAGEMENT_API_TOKEN: MANAGEMENT_TOKEN,
    CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
}

function baseConfig() {
  return {
    name: "edge-command-panel",
    main: "src/index.ts",
    compatibility_date: "2026-08-01",
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "panel.example.com", custom_domain: true }],
    vars: {
      PUBLIC_URL: "https://panel.example.com",
      USAGE_REQUESTS_LIMIT: "90000",
      CLOUDFLARE_API_TOKEN: "must-not-survive",
    },
    assets: {
      directory: "./frontend/dist",
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    durable_objects: {
      bindings: [{ name: "HUB", class_name: "CommandHub" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CommandHub"] }],
  };
}

function withEnv(overrides = {}) {
  const env = baseEnv();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

async function run(overrides = {}, baseOverrides = {}) {
  const configPath = join(tempDir, "wrangler.production.generated.json");
  const secretsPath = join(tempDir, "worker-secrets.json");
  const base = { ...baseConfig(), ...baseOverrides };
  const result = await prepareCloudflareDeploy({
    env: withEnv(overrides),
    baseConfig: base,
    configOut: configPath,
    secretsOut: secretsPath,
  });
  return {
    result,
    base,
    configPath,
    secretsPath,
    config: JSON.parse(await readFile(configPath, "utf8")),
    secrets: JSON.parse(await readFile(secretsPath, "utf8")),
  };
}

let tempDir;

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  tempDir = await mkdtemp(join(TMP_ROOT, "ecp-cf-deploy-"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("prepareCloudflareDeploy defaults and overrides", () => {
  it("keeps the default https origin and generates account/routes/vars", async () => {
    const { result, base, config } = await run({
      PUBLIC_URL: undefined,
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    });

    expect(result.publicUrl).toBe(DEFAULT_PUBLIC_URL);
    expect(result.hostname).toBe("ssh.zhouhaoze.com");
    expect(config.account_id).toBe(ACCOUNT_ID);
    expect(config.routes).toEqual([
      { pattern: "ssh.zhouhaoze.com", custom_domain: true },
    ]);
    expect(config.vars.PUBLIC_URL).toBe(DEFAULT_PUBLIC_URL);
    expect(config.vars.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
    expect(config.vars.ACCESS_TEAM_DOMAIN).toBe("https://team.cloudflareaccess.com");
    expect(config.vars.ACCESS_UI_AUD).toBe("aud-ui");
    expect(config.vars.USAGE_REQUESTS_LIMIT).toBe("90000");
    expect(config.vars.ACCESS_API_CLIENT_ID).toBeUndefined();
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.assets).toEqual(base.assets);
    expect(config.durable_objects).toEqual(base.durable_objects);
    expect(config.migrations).toEqual(base.migrations);
  });

  it("uses a custom origin and optional ACCESS_API_CLIENT_ID", async () => {
    const { config, result } = await run({
      PUBLIC_URL: "https://cmd.example.net",
      ACCESS_API_CLIENT_ID: "api-client-id",
    });

    expect(result.hostname).toBe("cmd.example.net");
    expect(config.routes).toEqual([
      { pattern: "cmd.example.net", custom_domain: true },
    ]);
    expect(config.vars.ACCESS_API_CLIENT_ID).toBe("api-client-id");
  });

  it("merges comments and trailing commas in the base JSONC config", () => {
    const parsed = parseJsonc(`{
      // example
      "name": "edge-command-panel",
      "workers_dev": false,
      "vars": {
        "USAGE_REQUESTS_LIMIT": "90000", /* budget */
      },
    }`);
    expect(parsed.name).toBe("edge-command-panel");
    expect(parsed.vars.USAGE_REQUESTS_LIMIT).toBe("90000");
  });
});

describe("prepareCloudflareDeploy validation", () => {
  it("rejects every missing required value", async () => {
    const required = [
      "CLOUDFLARE_ACCOUNT_ID",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_UI_AUD",
      "ACCESS_API_AUD",
      "ACCESS_AGENT_AUD",
      "ACCESS_ENROLL_AUD",
      "AGENT_ACCESS_APP_ID",
      "AGENT_ACCESS_POLICY_ID",
      "ENROLL_ACCESS_APP_ID",
      "ENROLL_ACCESS_POLICY_ID",
      "CF_ACCESS_MANAGEMENT_API_TOKEN",
      "CREDENTIAL_ENCRYPTION_KEY",
    ];
    for (const name of required) {
      await expect(run({ [name]: undefined })).rejects.toThrow(name);
    }
  });

  it("rejects a non-32-hex account, non-https/path/port PUBLIC_URL, and invalid team domain", async () => {
    await expect(run({ CLOUDFLARE_ACCOUNT_ID: "not-32-hex" })).rejects.toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    for (const value of [
      "http://panel.example.com",
      "https://panel.example.com/path",
      "https://panel.example.com:8443",
      "https://panel.example.com?x=1",
    ]) {
      await expect(run({ PUBLIC_URL: value })).rejects.toThrow(/PUBLIC_URL/);
    }
    for (const value of [
      "http://team.cloudflareaccess.com",
      "https://team.cloudflareaccess.com/path",
      "https://team.cloudflareaccess.com:8443",
    ]) {
      await expect(run({ ACCESS_TEAM_DOMAIN: value })).rejects.toThrow(
        /ACCESS_TEAM_DOMAIN/,
      );
    }
  });

  it("rejects duplicate Access audiences without printing their values", async () => {
    let message = "";
    try {
      await run({ ACCESS_API_AUD: "aud-ui" });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/Access audiences must be distinct/);
    expect(message).toContain("ACCESS_API_AUD");
    expect(message).not.toContain("aud-ui");
  });

  it("strictly validates the AES key and does not echo it", async () => {
    const invalidValues = [
      "not-base64-secret-value",
      Buffer.alloc(16, 1).toString("base64"),
      `${ENCRYPTION_KEY.slice(0, -1)}!`,
      `${ENCRYPTION_KEY}=`,
    ];
    for (const value of invalidValues) {
      let message = "";
      try {
        await run({ CREDENTIAL_ENCRYPTION_KEY: value });
      } catch (error) {
        message = error.message;
      }
      expect(message).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
      expect(message).not.toContain(value);
    }
  });
});

describe("prepareCloudflareDeploy secret separation and file handling", () => {
  it("writes only the two runtime secrets and keeps deploy/process tokens out", async () => {
    const { config, configPath, secrets, secretsPath } = await run({
      CF_DEPLOY_API_TOKEN: DEPLOY_TOKEN,
      CLOUDFLARE_API_TOKEN: "process-token-must-not-survive",
    });

    expect(Object.keys(secrets).sort()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CREDENTIAL_ENCRYPTION_KEY",
    ]);
    expect(secrets.CLOUDFLARE_API_TOKEN).toBe(MANAGEMENT_TOKEN);
    expect(secrets.CREDENTIAL_ENCRYPTION_KEY).toBe(ENCRYPTION_KEY);

    for (const forbidden of [
      "CLOUDFLARE_API_TOKEN",
      "CREDENTIAL_ENCRYPTION_KEY",
      "CF_ACCESS_MANAGEMENT_API_TOKEN",
      "CF_DEPLOY_API_TOKEN",
      "ACCESS_JWKS",
      "CLOUDFLARE_API_BASE",
    ]) {
      expect(config.vars[forbidden]).toBeUndefined();
    }

    const configText = await readFile(configPath, "utf8");
    const secretsText = await readFile(secretsPath, "utf8");
    expect(configText).not.toContain(DEPLOY_TOKEN);
    expect(secretsText).not.toContain(DEPLOY_TOKEN);
    expect(configText).not.toContain("process-token-must-not-survive");
    expect(secretsText).not.toContain("process-token-must-not-survive");
  });

  it("keeps JSON secret values literal, without dotenv-style expansion", async () => {
    const literalToken = "token-$CF_DEPLOY_API_TOKEN-${HOME}";
    const { secrets, secretsPath } = await run({
      CF_ACCESS_MANAGEMENT_API_TOKEN: literalToken,
      CF_DEPLOY_API_TOKEN: DEPLOY_TOKEN,
    });
    expect(secrets.CLOUDFLARE_API_TOKEN).toBe(literalToken);
    const text = await readFile(secretsPath, "utf8");
    expect(text).toContain(literalToken);
    expect(text).not.toContain(DEPLOY_TOKEN);
  });

  it("writes the secrets file with mode 0600", async () => {
    const { configPath, secretsPath } = await run();
    expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(configPath)).mode & 0o777).toBe(0o644);
  });

  it("fails without writing files when a runtime secret is invalid", async () => {
    await expect(
      run({ CREDENTIAL_ENCRYPTION_KEY: "not-base64-secret-value" }),
    ).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    await expect(stat(join(tempDir, "worker-secrets.json"))).rejects.toThrow();
    await expect(
      stat(join(tempDir, "wrangler.production.generated.json")),
    ).rejects.toThrow();
  });

  it("reads the checked-in wrangler.jsonc when no base object is supplied", async () => {
    const baseConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
    const configPath = join(tempDir, "generated.json");
    const secretsPath = join(tempDir, "secrets.json");
    await prepareCloudflareDeploy({
      env: withEnv(),
      baseConfigPath,
      configOut: configPath,
      secretsOut: secretsPath,
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.main).toBe("src/index.ts");
    expect(config.assets.binding).toBe("ASSETS");
    expect(config.durable_objects.bindings[0].class_name).toBe("CommandHub");
    expect(config.migrations[0].new_sqlite_classes).toEqual(["CommandHub"]);
  });
});
