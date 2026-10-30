import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInstallCommand,
  buildInstallInner,
  installOneLineCommand,
} from "../src/install-command";

// Node-only integration test for the generated one-line install command.
// Everything runs against mock `id`/`sudo`/`curl` binaries plus a stub
// installer payload inside the workspace scratch dir: no real sudo, no
// systemd, no network. Assertions never compare the raw command or secrets
// through expect() snapshots — failure diffs only reveal digests and flags,
// never credential-bearing text.

const TMP_ROOT = fileURLToPath(new URL("../.paseo-scratch/test-tmp/", import.meta.url));
const BASH = "/bin/bash";
const ROOT_UID = 0;
const ALICE_UID = 1000;

const BASE = "https://panel.example.com/b&x?zone=edge";
const MODE = "direct";
const AGENT_ID = `ag-en't-&;"id $x |boom*`;

// Relative sentinel: if quoting ever broke, the embedded command
// substitution `$(touch ./pwnt)` would create this file in the case cwd.
const PWN_SENTINEL = "pwnt";

// Credentials packed with characters that only survive when the generated
// command quotes them correctly: single quote, double quote, backslash, $,
// spaces, pipes, semicolons. Values are compared via digests and marker files.
const clientId = `cli'en&i- "d $(touch ./${PWN_SENTINEL}) ok`;
const clientSecret = `s$\\e"cre't &|;\\ ok`;

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fakeId(uid) {
  return `#!/bin/sh\nprintf '%s\n' '${uid}'\n`;
}

// Records its argv one-per-line, exports the invoking-account metadata the
// way real sudo does (metadata passed through to the installer stub), then
// execs the identical command (no privilege change) so the rest of the
// pipeline runs for real.
function fakeSudo() {
  return [
    "#!/bin/sh",
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$SUDO_LOG"; done',
    "export SUDO_USER=testuser-alice",
    "export SUDO_UID=1000",
    'exec "$@"',
    "",
  ].join("\n");
}

function fakeCurl({ fail }) {
  if (fail) return "#!/bin/sh\nexit 7\n";
  return [
    "#!/bin/sh",
    "out=",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    'cat "$CURL_PAYLOAD" > "$out"',
    "",
  ].join("\n");
}

// Stub for the downloaded generic installer: records the ECP_* environment the
// real installer would receive, without touching any system state.
function fakeInstaller() {
  return [
    "#!/usr/bin/env bash",
    "{",
    "printf '%s\\n' 'ran=installer'",
    "printf '%s=%s\\n' MECH_UID \"$(id -u)\"",
    "printf 'SUDO_USER=%s\\n' \"${SUDO_USER-}\"",
    "printf 'SUDO_UID=%s\\n' \"${SUDO_UID-}\"",
    "printf 'ECP_URL=%s\\n' \"${ECP_URL-}\"",
    "printf 'ECP_MODE=%s\\n' \"${ECP_MODE-}\"",
    "printf 'ECP_CLIENT_ID=%s\\n' \"${ECP_CLIENT_ID-}\"",
    "printf 'ECP_CLIENT_SECRET=%s\\n' \"${ECP_CLIENT_SECRET-}\"",
    "printf 'ECP_AGENT_ID=%s\\n' \"${ECP_AGENT_ID-}\"",
    "} > \"$INSTALL_LOG\"",
    "",
  ].join("\n");
}

async function setupCase(name, { uid, curlFail }) {
  await mkdir(TMP_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TMP_ROOT, `${name}-`));
  const binDir = join(dir, "fakebin");
  await mkdir(binDir, { recursive: true });
  const writeBin = (name, content) => writeFile(join(binDir, name), content, { mode: 0o755 });
  await writeBin("id", fakeId(uid));
  await writeBin("sudo", fakeSudo());
  await writeBin("curl", fakeCurl({ fail: curlFail }));
  const payload = join(dir, "payload.sh");
  await writeFile(payload, fakeInstaller(), { mode: 0o755 });
  const spawnEnv = {
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: dir,
    SUDO_LOG: join(dir, "sudo.args"),
    INSTALL_LOG: join(dir, "install.log"),
    CURL_PAYLOAD: payload,
  };
  const { envs, inner, command } = buildInstallCommand(
    BASE,
    MODE,
    { clientId, clientSecret },
    AGENT_ID,
  );
  return { dir, spawnEnv, envs, inner, command };
}

function runCommand(dir, spawnEnv, command) {
  const res = spawnSync(BASH, ["-c", command], { cwd: dir, env: spawnEnv, encoding: "utf8" });
  return { status: res.status, error: res.error };
}

async function expectAbsent(dir, name) {
  await expect(stat(join(dir, name))).rejects.toThrow();
}

function parseLog(content) {
  const map = {};
  for (const line of content.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

// Credential-bearing equality via digest only — no failure output leaks text.
function expectSecretEq(actual, expected, trace) {
  expect(`${trace}:${sha(actual)}`).toBe(`${trace}:${sha(expected)}`);
}

const SECRET_PAIRS = () => [
  ["ECP_URL", BASE],
  ["ECP_MODE", MODE],
  ["ECP_CLIENT_ID", clientId],
  ["ECP_CLIENT_SECRET", clientSecret],
  ["ECP_AGENT_ID", AGENT_ID],
];

describe("generated install command (mocked uid/sudo/curl)", () => {
  it("builds the root/sudo branch around the identical bash command", () => {
    const inner = buildInstallInner(BASE, MODE, { clientId, clientSecret }, AGENT_ID);
    const command = installOneLineCommand(inner);
    const bashCmd = `bash -o pipefail -c ${shellQuote(inner)}`;
    // Full structural equality via digest (never snapshot raw command).
    expect(sha(command)).toBe(
      sha(`if [ "$(id -u)" -eq 0 ]; then ${bashCmd}; else sudo ${bashCmd}; fi`),
    );
    // Secret-free structural flags for debuggability on failure.
    expect("posix-uid-guard?" + command.includes('if [ "$(id -u)" -eq 0 ]; then ')).toBe(
      "posix-uid-guard?true",
    );
    expect("root-branch?" + (command.startsWith(`if [ "$(id -u)" -eq 0 ]; then `) ? "1" : "0")).toBe(
      "root-branch?1",
    );
    expect(
      "sudo-branch?" + command.includes(`; else sudo bash -o pipefail -c ${shellQuote(inner)}`),
    ).toBe("sudo-branch?true");
    expect(
      "cf-headers?" +
        `${command.includes("CF-Access-Client-Id:")},${command.includes("CF-Access-Client-Secret:")}`,
    ).toBe("cf-headers?true,true");
    expect(
      "dl-guard?" + (inner.includes("curl -fsSL --proto '=https' --tlsv1.2") ? "1" : "0"),
    ).toBe("dl-guard?1");
    expect("export-env?" + command.includes("env ECP_URL=")).toBe("export-env?true");
    // The identical bash command appears exactly twice (root + sudo branch).
    expect("dup-count?" + command.split(bashCmd).length).toBe("dup-count?3");
    expect("pipefail-count?" + command.split("bash -o pipefail -c ").length).toBe("pipefail-count?3");
  });

  it("root (mocked uid 0) runs the installer directly without sudo", async () => {
    const { dir, spawnEnv, command } = await setupCase("root", {
      uid: ROOT_UID,
      curlFail: false,
    });
    try {
      const { status } = runCommand(dir, spawnEnv, command);
      expect("exit?" + status).toBe("exit?0");
      const reported = parseLog(await readFile(join(dir, "install.log"), "utf8"));
      expect("ran?" + reported.ran).toBe("ran?installer");
      expect("uid?" + reported.MECH_UID).toBe(`uid?${ROOT_UID}`);
      for (const pair of SECRET_PAIRS()) {
        expectSecretEq(reported[pair[0]] ?? "", pair[1], pair[0]);
      }
      await expectAbsent(dir, "sudo.args");
      await expectAbsent(dir, PWN_SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("non-root (mocked uid != 0) re-runs the same bash command via sudo, quotes intact", async () => {
    const { dir, spawnEnv, inner, command } = await setupCase("nonroot", {
      uid: ALICE_UID,
      curlFail: false,
    });
    try {
      const { status } = runCommand(dir, spawnEnv, command);
      expect("exit?" + status).toBe("exit?0");
      const reported = parseLog(await readFile(join(dir, "install.log"), "utf8"));
      expect("ran?" + reported.ran).toBe("ran?installer");
      expect("uid?" + reported.MECH_UID).toBe(`uid?${ALICE_UID}`);
      for (const pair of SECRET_PAIRS()) {
        expectSecretEq(reported[pair[0]] ?? "", pair[1], pair[0]);
      }
      // sudo receives exactly the same bash invocation with pre-quoting intact.
      const sudoArgs = (await readFile(join(dir, "sudo.args"), "utf8")).split("\n")
        .filter((line) => line !== "");
      expect("sudo-arg-count?" + sudoArgs.length).toBe("sudo-arg-count?5");
      expect(
        "sudo-pre?[" + [sudoArgs[0], sudoArgs[1], sudoArgs[2]].join(",") + "]",
      ).toBe("sudo-pre?[bash,-o,pipefail]");
      expect("sudo-c?" + sudoArgs[3]).toBe("sudo-c?-c");
      expectSecretEq(sudoArgs[4] ?? "", inner, "sudo-bash-eval");
      // sudo keeps the invoking-account metadata available to the installer stub.
      expect("sudo-user?" + (reported.SUDO_USER ?? "")).toBe("sudo-user?testuser-alice");
      expect("sudo-uid?" + (reported.SUDO_UID ?? "")).toBe("sudo-uid?1000");
      await expectAbsent(dir, PWN_SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("download failure keeps the installer payload from executing", async () => {
    for (const [label, uid] of [["root", ROOT_UID], ["nonroot", ALICE_UID]]) {
      const { dir, spawnEnv, command } = await setupCase(`dl-fail-${label}`, {
        uid,
        curlFail: true,
      });
      try {
        const { status } = runCommand(dir, spawnEnv, command);
        expect(`${label}-exit-nonzero?` + (status !== 0 ? "1" : "0")).toBe(
          `${label}-exit-nonzero?1`,
        );
        await expectAbsent(dir, "install.log");
        await expectAbsent(dir, PWN_SENTINEL);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
