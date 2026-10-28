#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { downloadAgentRelease, verifyStagedRelease } from "./agent-release.mjs";

const noAgent = process.argv.includes("--no-agent");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function requireFrontendBuild() {
  if (!(await exists("frontend/dist/index.html"))) {
    throw new Error(
      "--no-agent requires a prebuilt frontend/dist/index.html; run npm run build first",
    );
  }
}

if (noAgent) {
  // deploy:dry re-hashes the already downloaded assets against the lock. It
  // never treats file existence alone as proof that the assets are correct.
  await requireFrontendBuild();
  const manifest = await verifyStagedRelease();
  console.log(`re-verified staged ${manifest.tag} assets against agent-release.json`);
} else {
  if (!(await exists("frontend/package.json"))) {
    throw new Error("full build requires frontend/package.json");
  }
  console.log("building frontend");
  await run("npm", ["--prefix", "frontend", "run", "build"]);
  // Build-stage only: no runtime GitHub dependency, no Go toolchain.
  await downloadAgentRelease();
}

if (!(await exists("frontend/dist/index.html"))) {
  throw new Error("frontend/dist/index.html is missing");
}

const env = {
  XDG_CONFIG_HOME: resolve(".paseo-scratch/config"),
  WRANGLER_LOG_PATH: resolve(".paseo-scratch/wrangler.log"),
  WRANGLER_SEND_METRICS: "false",
};
console.log("running wrangler deploy --dry-run (no deployment)");
await run(
  resolve("node_modules/.bin/wrangler"),
  ["deploy", "--dry-run", "--outdir", ".paseo-scratch/dry-run"],
  env,
);
console.log("dry-run bundle complete; nothing was deployed");
