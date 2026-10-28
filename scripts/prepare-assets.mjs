import { mkdir, access, readFile } from "node:fs/promises";

export async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureAssets() {
  await mkdir("frontend/dist/downloads", { recursive: true });
  const index = "frontend/dist/index.html";
  if (!(await exists(index))) {
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        index,
        "<!doctype html><meta charset=utf-8><title>Edge Command Panel</title><p>Frontend build not installed.</p>\n",
      ),
    );
  }
  const installer = "frontend/dist/downloads/install.sh";
  if (!(await exists(installer))) {
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        installer,
        "#!/usr/bin/env bash\nset -euo pipefail\n# TEST-ONLY placeholder. The real installer is downloaded and hash-verified\n# from the fixed GitHub Release by npm run build / npm run build:agent.\necho 'agent installer placeholder; run the release build' >&2\nexit 1\n",
        { mode: 0o755 },
      ),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureAssets();
  console.log("assets directory ready: frontend/dist");
}
