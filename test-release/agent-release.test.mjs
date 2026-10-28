import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_NAMES,
  downloadAgentRelease,
  parseChecksums,
  sha256,
  validateManifest,
  verifyStagedRelease,
} from "../scripts/agent-release.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const MANIFEST_FIXTURE = join(FIXTURES, "agent-release.fixture.json");
const RELEASE_FIXTURE = join(FIXTURES, "release");
const TMP_ROOT = "/tmp/opencode";

async function fixtureManifest() {
  return JSON.parse(await readFile(MANIFEST_FIXTURE, "utf8"));
}

async function fixtureRelease() {
  const sums = await readFile(join(RELEASE_FIXTURE, "SHA256SUMS"), "utf8");
  const assets = {};
  for (const name of ASSET_NAMES) {
    assets[name] = await readFile(join(RELEASE_FIXTURE, name));
  }
  return { sums, assets };
}

function nameFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop());
}

function fakeFetch({ sums, assets, overrides = {} }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const name = nameFromUrl(url);
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      return overrides[name]();
    }
    if (name === "SHA256SUMS") {
      return new Response(sums, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (!Object.prototype.hasOwnProperty.call(assets, name)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(assets[name], {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  };
  fn.calls = calls;
  return fn;
}

async function fakeResponse(status, body, contentType) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

let tempDir;

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  tempDir = await mkdtemp(join(TMP_ROOT, "ecp-release-"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function paths() {
  return {
    downloadsDir: join(tempDir, "downloads"),
    cacheDir: join(tempDir, "cache"),
  };
}

describe("fixed Agent release downloader", () => {
  it("downloads SHA256SUMS first, verifies all three assets, and stages them atomically", async () => {
    const manifest = await fixtureManifest();
    const { sums, assets } = await fixtureRelease();
    const fetchImpl = fakeFetch({ sums, assets });
    const { downloadsDir, cacheDir } = paths();

    const result = await downloadAgentRelease({
      fetchImpl,
      manifestPath: MANIFEST_FIXTURE,
      downloadsDir,
      cacheDir,
      logger: () => {},
    });

    expect(result.tag).toBe("agent-v0.1.0");
    expect(result.assets.map((asset) => asset.name).sort()).toEqual([...ASSET_NAMES].sort());
    expect(nameFromUrl(fetchImpl.calls[0])).toBe("SHA256SUMS");
    expect(fetchImpl.calls[0]).toContain("/releases/download/agent-v0.1.0/");
    for (const name of ASSET_NAMES) {
      const staged = await readFile(join(downloadsDir, name));
      expect(sha256(staged)).toBe(manifest.assets[name]);
      expect(await readFile(join(cacheDir, "agent-v0.1.0", name))).toEqual(staged);
    }
    expect((await stat(join(downloadsDir, "install.sh"))).mode & 0o111).not.toBe(0);
  });

  it("reuses a verified cache but redownloads a stale cache instead of trusting it", async () => {
    const manifest = await fixtureManifest();
    const { sums, assets } = await fixtureRelease();
    const { downloadsDir, cacheDir } = paths();
    const stalePath = join(cacheDir, "agent-v0.1.0", "edge-agent-linux-amd64");
    await mkdir(join(cacheDir, "agent-v0.1.0"), { recursive: true });
    await writeFile(stalePath, "stale-but-not-the-release");

    const fetchImpl = fakeFetch({ sums, assets });
    await downloadAgentRelease({
      fetchImpl,
      manifestPath: MANIFEST_FIXTURE,
      downloadsDir,
      cacheDir,
      logger: () => {},
    });

    expect(fetchImpl.calls.some((url) => url.endsWith("/edge-agent-linux-amd64"))).toBe(true);
    expect(sha256(await readFile(stalePath))).toBe(manifest.assets["edge-agent-linux-amd64"]);
    expect(sha256(await readFile(join(downloadsDir, "edge-agent-linux-amd64")))).toBe(
      manifest.assets["edge-agent-linux-amd64"],
    );
  });

  it("fails rather than falling back to a stale cache when the release asset is missing", async () => {
    const { sums, assets } = await fixtureRelease();
    const { downloadsDir, cacheDir } = paths();
    const stalePath = join(cacheDir, "agent-v0.1.0", "edge-agent-linux-amd64");
    await mkdir(join(cacheDir, "agent-v0.1.0"), { recursive: true });
    await writeFile(stalePath, "stale-but-not-the-release");
    const fetchImpl = fakeFetch({
      sums,
      assets,
      overrides: {
        "edge-agent-linux-amd64": () => new Response("not found", { status: 404 }),
      },
    });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath: MANIFEST_FIXTURE,
        downloadsDir,
        cacheDir,
        logger: () => {},
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects a manifest whose SHA256SUMS hash is wrong", async () => {
    const manifest = await fixtureManifest();
    manifest.checksumsSha256 = "0".repeat(64);
    const manifestPath = join(tempDir, "agent-release.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { sums, assets } = await fixtureRelease();
    const fetchImpl = fakeFetch({ sums, assets });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/SHA256SUMS SHA-256 mismatch/);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("rejects a mismatch between SHA256SUMS and the locked asset hashes", async () => {
    const manifest = await fixtureManifest();
    manifest.assets["edge-agent-linux-arm64"] = "1".repeat(64);
    const manifestPath = join(tempDir, "agent-release.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const { sums, assets } = await fixtureRelease();
    const fetchImpl = fakeFetch({ sums, assets });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/between SHA256SUMS and agent-release.json/);
    // Verification stops before downloading any binary.
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("rejects downloaded asset bytes that do not match the verified hash", async () => {
    const { sums, assets } = await fixtureRelease();
    const tampered = { ...assets, "edge-agent-linux-amd64": Buffer.from("tampered agent\n") };
    const fetchImpl = fakeFetch({ sums, assets: tampered });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath: MANIFEST_FIXTURE,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/edge-agent-linux-amd64 SHA-256 mismatch/);
  });

  it("rejects HTTP 404 for a missing release asset", async () => {
    const { sums, assets } = await fixtureRelease();
    const fetchImpl = fakeFetch({
      sums,
      assets,
      overrides: {
        "edge-agent-linux-arm64": () => new Response("not found", { status: 404 }),
      },
    });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath: MANIFEST_FIXTURE,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects an HTML page served instead of install.sh", async () => {
    const { sums, assets } = await fixtureRelease();
    const fetchImpl = fakeFetch({
      sums,
      assets,
      overrides: {
        "install.sh": () => fakeResponse(200, "<!doctype html><title>not found</title>", "text/html"),
      },
    });

    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath: MANIFEST_FIXTURE,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/HTML page/);
  });

  it("fails before any request for an unlocked manifest", async () => {
    const fetchImpl = fakeFetch({ sums: "", assets: {} });
    const unlocked = await fixtureManifest();
    unlocked.agentCommit = "PENDING_40_HEX_AGENT_COMMIT";
    const manifestPath = join(tempDir, "agent-release.json");
    await writeFile(manifestPath, JSON.stringify(unlocked));

    expect(() => validateManifest(unlocked)).toThrow(
      /agentCommit must be a locked 40-character lowercase hex/,
    );
    await expect(
      downloadAgentRelease({
        fetchImpl,
        manifestPath,
        ...paths(),
        logger: () => {},
      }),
    ).rejects.toThrow(/is invalid/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("parses exactly three strict SHA256SUMS entries", async () => {
    const manifest = await fixtureManifest();
    const { sums } = await fixtureRelease();
    expect(parseChecksums(sums).size).toBe(3);

    expect(() => parseChecksums(`${sums.split("\n")[0]}\n`)).toThrow(/exactly 3 entries/);
    expect(() =>
      parseChecksums(`${sums}e24429264562533af441ec53e3e918f89c259252290e739d0559ec42f43801b5  extra.bin\n`),
    ).toThrow(/exactly 3 entries/);
    expect(() =>
      parseChecksums(sums.replace(manifest.assets["install.sh"], manifest.assets["install.sh"].toUpperCase())),
    ).toThrow(/invalid line/);
  });
});

describe("deploy:dry re-verification", () => {
  it("re-hashes staged assets against the lock and rejects tampering", async () => {
    const manifest = await fixtureManifest();
    const { assets } = await fixtureRelease();
    const downloadsDir = join(tempDir, "downloads");
    await mkdir(downloadsDir, { recursive: true });
    for (const name of ASSET_NAMES) {
      await writeFile(join(downloadsDir, name), assets[name]);
    }

    const verified = await verifyStagedRelease({
      manifestPath: MANIFEST_FIXTURE,
      downloadsDir,
    });
    expect(verified.tag).toBe("agent-v0.1.0");

    await writeFile(join(downloadsDir, "install.sh"), "tampered installer\n");
    await expect(
      verifyStagedRelease({ manifestPath: MANIFEST_FIXTURE, downloadsDir }),
    ).rejects.toThrow(/does not match agent-release.json/);
  });

  it("rejects missing staged assets instead of trusting existence", async () => {
    const downloadsDir = join(tempDir, "downloads");
    await mkdir(downloadsDir, { recursive: true });

    await expect(
      verifyStagedRelease({ manifestPath: MANIFEST_FIXTURE, downloadsDir }),
    ).rejects.toThrow(/missing staged release asset/);
  });

  it("rejects an HTML file staged as an asset", async () => {
    const { assets } = await fixtureRelease();
    const downloadsDir = join(tempDir, "downloads");
    await mkdir(downloadsDir, { recursive: true });
    for (const name of ASSET_NAMES) {
      await writeFile(join(downloadsDir, name), assets[name]);
    }
    await writeFile(join(downloadsDir, "edge-agent-linux-amd64"), "<!doctype html><html></html>");

    await expect(
      verifyStagedRelease({ manifestPath: MANIFEST_FIXTURE, downloadsDir }),
    ).rejects.toThrow(/is HTML/);
  });
});
