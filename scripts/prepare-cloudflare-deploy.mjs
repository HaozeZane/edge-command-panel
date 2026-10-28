#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const DEFAULT_PUBLIC_URL = "https://ssh.zhouhaoze.com";
export const DEFAULT_BASE_CONFIG = "wrangler.jsonc";
export const DEFAULT_CONFIG_OUT = "wrangler.production.generated.json";

const REQUIRED_ACCESS_VARS = [
  "ACCESS_UI_AUD",
  "ACCESS_API_AUD",
  "ACCESS_AGENT_AUD",
  "ACCESS_ENROLL_AUD",
  "AGENT_ACCESS_APP_ID",
  "AGENT_ACCESS_POLICY_ID",
  "ENROLL_ACCESS_APP_ID",
  "ENROLL_ACCESS_POLICY_ID",
];

const FORBIDDEN_CONFIG_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "CREDENTIAL_ENCRYPTION_KEY",
  "CF_ACCESS_MANAGEMENT_API_TOKEN",
  "CF_DEPLOY_API_TOKEN",
  "ACCESS_JWKS",
  "CLOUDFLARE_API_BASE",
];

function fail(message) {
  throw new Error(`Cloudflare deployment configuration: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} is required`);
  }
  if (value !== value.trim()) {
    fail(`${name} must not have leading or trailing whitespace`);
  }
  return value;
}

/**
 * Minimal JSONC reader for wrangler.jsonc. Comments are stripped with a
 * string-aware scanner, then trailing commas are removed. No dependency is
 * added and no environment value is interpolated.
 */
export function parseJsonc(text) {
  const source = text.replace(/^\uFEFF/, "");
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length) {
        if (/\s/.test(source[lookahead])) {
          lookahead += 1;
          continue;
        }
        if (source[lookahead] === "/" && source[lookahead + 1] === "/") {
          while (lookahead < source.length && source[lookahead] !== "\n") lookahead += 1;
          continue;
        }
        if (source[lookahead] === "/" && source[lookahead + 1] === "*") {
          lookahead += 2;
          while (
            lookahead < source.length &&
            !(source[lookahead] === "*" && source[lookahead + 1] === "/")
          ) {
            lookahead += 1;
          }
          lookahead += 2;
          continue;
        }
        break;
      }
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }

    output += char;
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`base Wrangler config is not valid JSONC (${error.message})`);
  }
}

function parseHttpsOrigin(name, raw, { allowBareHost = false } = {}) {
  if (typeof raw !== "string" || raw.trim() === "") fail(`${name} is required`);
  const trimmed = raw.trim();
  const candidate =
    allowBareHost && !/^[a-z]+:\/\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    fail(`${name} must be a valid https origin`);
  }
  if (url.protocol !== "https:") fail(`${name} must use https`);
  if (url.username || url.password) fail(`${name} must not contain credentials`);
  if (url.pathname !== "/" || url.search || url.hash) {
    fail(`${name} must be an https origin without a path, query, or fragment`);
  }
  if (url.port) fail(`${name} must not include a port`);
  if (!url.hostname) fail(`${name} must include a hostname`);
  return url.origin;
}

function validateAccountId(raw) {
  if (!/^[0-9a-f]{32}$/i.test(raw)) {
    fail("CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters");
  }
  return raw.toLowerCase();
}

function validateEncryptionKey(raw) {
  if (typeof raw !== "string" || raw === "") {
    fail("CREDENTIAL_ENCRYPTION_KEY is required");
  }
  if (raw !== raw.trim()) {
    fail("CREDENTIAL_ENCRYPTION_KEY must not have leading or trailing whitespace");
  }
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    fail("CREDENTIAL_ENCRYPTION_KEY must be canonical base64");
  }
  let bytes;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    fail("CREDENTIAL_ENCRYPTION_KEY must be canonical base64");
  }
  if (bytes.length !== 32) {
    fail("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  if (bytes.toString("base64") !== raw) {
    fail("CREDENTIAL_ENCRYPTION_KEY must be canonical base64");
  }
  return raw;
}

function accessVars(env) {
  const vars = {};
  for (const name of REQUIRED_ACCESS_VARS) {
    vars[name] = requiredEnv(env, name);
  }
  const auds = {
    ACCESS_UI_AUD: vars.ACCESS_UI_AUD,
    ACCESS_API_AUD: vars.ACCESS_API_AUD,
    ACCESS_AGENT_AUD: vars.ACCESS_AGENT_AUD,
    ACCESS_ENROLL_AUD: vars.ACCESS_ENROLL_AUD,
  };
  const seen = new Map();
  for (const [name, value] of Object.entries(auds)) {
    const duplicate = seen.get(value);
    if (duplicate) {
      fail(`Access audiences must be distinct; ${name} duplicates ${duplicate}`);
    }
    seen.set(value, name);
  }
  return vars;
}

/**
 * Build the generated Wrangler config from the checked-in template plus
 * non-secret environment values. Secrets are never placed in `vars`.
 */
export function buildProductionConfig(baseConfig, env = process.env) {
  if (!isObject(baseConfig)) fail("base Wrangler config must be an object");

  const publicUrl = parseHttpsOrigin(
    "PUBLIC_URL",
    env.PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL,
  );
  const accountId = validateAccountId(requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID"));
  const teamDomain = parseHttpsOrigin(
    "ACCESS_TEAM_DOMAIN",
    requiredEnv(env, "ACCESS_TEAM_DOMAIN"),
    { allowBareHost: true },
  );
  const access = accessVars(env);
  const optionalClientId = (env.ACCESS_API_CLIENT_ID || "").trim();

  const baseVars = isObject(baseConfig.vars) ? { ...baseConfig.vars } : {};
  for (const name of FORBIDDEN_CONFIG_VARS) delete baseVars[name];

  const vars = {
    ...baseVars,
    PUBLIC_URL: publicUrl,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ...access,
    ACCESS_TEAM_DOMAIN: teamDomain,
  };
  if (optionalClientId) vars.ACCESS_API_CLIENT_ID = optionalClientId;
  else delete vars.ACCESS_API_CLIENT_ID;

  const hostname = new URL(publicUrl).hostname;
  const config = {
    ...baseConfig,
    account_id: accountId,
    routes: [{ pattern: hostname, custom_domain: true }],
    workers_dev: false,
    preview_urls: false,
    vars,
  };

  return { config, publicUrl, accountId, teamDomain, hostname };
}

/**
 * Only the two Worker runtime secrets go into the JSON secrets file. The
 * deploy token (CF_DEPLOY_API_TOKEN) is deliberately not accepted here.
 */
export function buildWorkerSecrets(env = process.env) {
  const managementToken = requiredEnv(env, "CF_ACCESS_MANAGEMENT_API_TOKEN");
  const encryptionKey = validateEncryptionKey(
    requiredEnv(env, "CREDENTIAL_ENCRYPTION_KEY"),
  );
  return {
    CLOUDFLARE_API_TOKEN: managementToken,
    CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
  };
}

export async function prepareCloudflareDeploy({
  env = process.env,
  baseConfigPath = DEFAULT_BASE_CONFIG,
  baseConfig,
  configOut = DEFAULT_CONFIG_OUT,
  secretsOut,
} = {}) {
  if (!secretsOut) {
    fail("--secrets-out is required (for GitHub Actions use $RUNNER_TEMP/worker-secrets.json)");
  }

  let base = baseConfig;
  if (!base) {
    let text;
    try {
      text = await readFile(baseConfigPath, "utf8");
    } catch {
      fail(`cannot read base Wrangler config ${baseConfigPath}`);
    }
    base = parseJsonc(text);
  }

  const built = buildProductionConfig(base, env);
  const secrets = buildWorkerSecrets(env);

  await mkdir(dirname(configOut), { recursive: true });
  await mkdir(dirname(secretsOut), { recursive: true });

  await writeFile(configOut, `${JSON.stringify(built.config, null, 2)}\n`, {
    mode: 0o644,
  });
  await chmod(configOut, 0o644);

  // JSON only: no dotenv interpolation, so a process-level deploy token can
  // never be expanded into this file.
  await writeFile(secretsOut, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(secretsOut, 0o600);

  return {
    configOut,
    secretsOut,
    publicUrl: built.publicUrl,
    accountId: built.accountId,
    hostname: built.hostname,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "base-config": { type: "string", default: DEFAULT_BASE_CONFIG },
      "config-out": { type: "string", default: DEFAULT_CONFIG_OUT },
      "secrets-out": { type: "string" },
    },
    allowPositionals: false,
  });

  const result = await prepareCloudflareDeploy({
    baseConfigPath: values["base-config"],
    configOut: values["config-out"],
    secretsOut: values["secrets-out"],
  });

  console.log(`wrote production Wrangler config: ${result.configOut}`);
  console.log(`wrote Worker secrets file: ${result.secretsOut} (mode 0600)`);
  console.log(`target account: ${result.accountId}; public origin: ${result.publicUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cloudflare deployment configuration failed");
    process.exitCode = 1;
  }
}
