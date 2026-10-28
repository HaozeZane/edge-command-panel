#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

export const AGENT_REPOSITORY = "HaozeZane/edge-command-panel";
export const SUMS_NAME = "SHA256SUMS";
export const ASSET_NAMES = Object.freeze([
  "edge-agent-linux-amd64",
  "edge-agent-linux-arm64",
  "install.sh",
]);
export const DEFAULT_MANIFEST_PATH = "agent-release.json";
export const DEFAULT_DOWNLOADS_DIR = "frontend/dist/downloads";
export const DEFAULT_CACHE_DIR = ".paseo-scratch/agent-release";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TAG = /^agent-v\d+\.\d+\.\d+$/;
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read release lock ${path}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`release lock ${path} is not valid JSON: ${error.message}`);
  }
  return manifest;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the fixed release lock. Every value must already be locked to a
 * concrete hash/commit; placeholders deliberately fail rather than falling
 * back to "latest" or skipping verification.
 */
export function validateManifest(manifest, source = DEFAULT_MANIFEST_PATH) {
  const fail = (message) => {
    throw new Error(`release lock ${source} is invalid: ${message}`);
  };
  if (!isObject(manifest)) fail("expected a JSON object");
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (manifest.repository !== AGENT_REPOSITORY) {
    fail(`repository must be exactly "${AGENT_REPOSITORY}"`);
  }
  if (typeof manifest.tag !== "string" || !TAG.test(manifest.tag)) {
    fail(`tag must look like agent-v0.1.0 (got ${JSON.stringify(manifest.tag)})`);
  }
  if (typeof manifest.agentCommit !== "string" || !HEX40.test(manifest.agentCommit)) {
    fail(
      "agentCommit must be a locked 40-character lowercase hex Agent source commit. " +
        "Fill it with the commit recorded for the published agent-v0.1.0 GitHub Release. " +
        "Placeholders are not accepted.",
    );
  }
  if (
    typeof manifest.checksumsSha256 !== "string" ||
    !HEX64.test(manifest.checksumsSha256)
  ) {
    fail(
      "checksumsSha256 must be the locked 64-character lowercase hex SHA-256 of SHA256SUMS. " +
        "Placeholders are not accepted.",
    );
  }
  if (!isObject(manifest.assets)) fail("assets must be an object");
  const actualNames = Object.keys(manifest.assets).sort();
  const expectedNames = [...ASSET_NAMES].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail(
      `assets must contain exactly these keys: ${ASSET_NAMES.join(", ")}; ` +
        `got ${actualNames.join(", ") || "(none)"}`,
    );
  }
  for (const name of ASSET_NAMES) {
    const hash = manifest.assets[name];
    if (typeof hash !== "string" || !HEX64.test(hash)) {
      fail(
        `assets["${name}"] must be a locked 64-character lowercase hex SHA-256. ` +
          "Placeholders are not accepted.",
      );
    }
  }
  return manifest;
}

export function releaseAssetUrl(manifest, name) {
  return `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${encodeURIComponent(name)}`;
}

function decodePrefix(buffer, length = 512) {
  return buffer.subarray(0, Math.min(buffer.length, length)).toString("utf8").trimStart().toLowerCase();
}

function looksLikeHtml(buffer, contentType = "") {
  if (contentType.toLowerCase().includes("text/html")) return true;
  const prefix = decodePrefix(buffer);
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}

async function downloadBuffer(fetchImpl, url, { kind, maxBytes }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      headers: { accept: kind === SUMS_NAME ? "text/plain, application/octet-stream" : "application/octet-stream" },
    });
  } catch (error) {
    throw new Error(`${kind} download failed (${url}): ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`${kind} download failed: HTTP ${response.status} (${url})`);
  }
  const contentType = response.headers.get("content-type") || "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${kind} download is too large (${declaredLength} bytes) (${url})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`${kind} download is too large (${buffer.length} bytes) (${url})`);
  }
  if (looksLikeHtml(buffer, contentType)) {
    throw new Error(
      `${kind} download returned an HTML page instead of a release asset (${url}); ` +
        "the release or asset name is wrong.",
    );
  }
  return buffer;
}

/**
 * Parse the fixed three-line SHA256SUMS format:
 *   <64 lowercase hex>  <filename>
 * Exactly the three locked asset names are accepted, with no duplicates.
 */
export function parseChecksums(text, expectedNames = ASSET_NAMES) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines.length !== expectedNames.length) {
    throw new Error(
      `SHA256SUMS must contain exactly ${expectedNames.length} entries; got ${lines.length}`,
    );
  }
  const result = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) [ *]([^/\\]+)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS has an invalid line: ${JSON.stringify(line)}`);
    }
    const [, hash, name] = match;
    if (!expectedNames.includes(name)) {
      throw new Error(`SHA256SUMS contains an unexpected asset: ${name}`);
    }
    if (result.has(name)) {
      throw new Error(`SHA256SUMS contains a duplicate asset: ${name}`);
    }
    result.set(name, hash);
  }
  for (const name of expectedNames) {
    if (!result.has(name)) throw new Error(`SHA256SUMS is missing ${name}`);
  }
  return result;
}

async function atomicWrite(path, data, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temp, data, { mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function assetMode(name) {
  return name === "install.sh" || name.startsWith("edge-agent-") ? 0o755 : 0o644;
}

async function readVerifiedCache(cachePath, expectedHash) {
  if (!(await exists(cachePath))) return null;
  const buffer = await readFile(cachePath);
  if (looksLikeHtml(buffer)) return null;
  return sha256(buffer) === expectedHash ? buffer : null;
}

/**
 * Build-stage downloader. It downloads and verifies SHA256SUMS before any
 * binary is fetched, then verifies every asset against the lock and writes it
 * atomically to frontend/dist/downloads.
 */
export async function downloadAgentRelease({
  fetchImpl = globalThis.fetch,
  manifestPath = DEFAULT_MANIFEST_PATH,
  downloadsDir = DEFAULT_DOWNLOADS_DIR,
  cacheDir = DEFAULT_CACHE_DIR,
  logger = console.log,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const manifest = validateManifest(await loadManifest(manifestPath), manifestPath);

  const sumsUrl = releaseAssetUrl(manifest, SUMS_NAME);
  logger(`fetching ${SUMS_NAME} from the fixed GitHub release`);
  const sumsBuffer = await downloadBuffer(fetchImpl, sumsUrl, {
    kind: SUMS_NAME,
    maxBytes: MAX_SUMS_BYTES,
  });
  const sumsHash = sha256(sumsBuffer);
  if (sumsHash !== manifest.checksumsSha256) {
    throw new Error(
      `${SUMS_NAME} SHA-256 mismatch: expected ${manifest.checksumsSha256}, got ${sumsHash}. ` +
        "The release contents do not match agent-release.json.",
    );
  }
  const sums = parseChecksums(sumsBuffer.toString("utf8"));
  for (const name of ASSET_NAMES) {
    if (sums.get(name) !== manifest.assets[name]) {
      throw new Error(
        `${name} hash mismatch between SHA256SUMS and agent-release.json: ` +
          `sums=${sums.get(name)}, lock=${manifest.assets[name]}`,
      );
    }
  }

  const verified = [];
  for (const name of ASSET_NAMES) {
    const expectedHash = manifest.assets[name];
    const cachePath = join(cacheDir, manifest.tag, name);
    let buffer = await readVerifiedCache(cachePath, expectedHash);
    if (buffer) {
      logger(`using verified cached ${name}`);
    } else {
      if (await exists(cachePath)) {
        logger(`discarding stale cached ${name}`);
        await rm(cachePath, { force: true });
      }
      const url = releaseAssetUrl(manifest, name);
      logger(`downloading ${name} from the fixed GitHub release`);
      buffer = await downloadBuffer(fetchImpl, url, {
        kind: name,
        maxBytes: MAX_ASSET_BYTES,
      });
      const actual = sha256(buffer);
      if (actual !== expectedHash) {
        throw new Error(
          `${name} SHA-256 mismatch: expected ${expectedHash}, got ${actual}. ` +
            "Refusing to stage this release.",
        );
      }
      await atomicWrite(cachePath, buffer, assetMode(name));
    }
    if (looksLikeHtml(buffer)) throw new Error(`${name} is HTML, not a release asset`);
    const actual = sha256(buffer);
    if (actual !== expectedHash) {
      throw new Error(`${name} SHA-256 mismatch: expected ${expectedHash}, got ${actual}`);
    }
    await atomicWrite(join(downloadsDir, name), buffer, assetMode(name));
    verified.push({ name, sha256: actual });
  }

  logger(`verified ${manifest.tag} (${manifest.agentCommit.slice(0, 12)}) for ${manifest.repository}`);
  return { tag: manifest.tag, repository: manifest.repository, assets: verified };
}

/**
 * deploy:dry path. It never trusts file existence: every staged asset is
 * re-hashed against the lock on every invocation.
 */
export async function verifyStagedRelease({
  manifestPath = DEFAULT_MANIFEST_PATH,
  downloadsDir = DEFAULT_DOWNLOADS_DIR,
} = {}) {
  const manifest = validateManifest(await loadManifest(manifestPath), manifestPath);
  for (const name of ASSET_NAMES) {
    const path = join(downloadsDir, name);
    if (!(await exists(path))) {
      throw new Error(
        `missing staged release asset ${path}; run npm run build (or npm run build:agent) first`,
      );
    }
    const buffer = await readFile(path);
    if (looksLikeHtml(buffer)) {
      throw new Error(`staged ${name} is HTML, not a release asset; rebuild it`);
    }
    const actual = sha256(buffer);
    if (actual !== manifest.assets[name]) {
      throw new Error(
        `staged ${name} does not match agent-release.json: expected ${manifest.assets[name]}, ` +
          `got ${actual}; run npm run build (or npm run build:agent) again`,
      );
    }
  }
  return manifest;
}
