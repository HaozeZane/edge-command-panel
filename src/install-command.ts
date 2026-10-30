import { shellQuote } from "./util";

export type InstallMode = "direct" | "enroll";

export interface InstallCreds {
  clientId: string;
  clientSecret: string;
}

export function installScriptUrl(base: string, mode: InstallMode): string {
  return `${base}/${mode === "direct" ? "agent" : "enroll"}/install.sh`;
}

export function buildInstallEnvs(
  base: string,
  mode: InstallMode,
  creds: InstallCreds,
  agentId: string | undefined,
): string[] {
  const envs = [
    `ECP_URL=${shellQuote(base)}`,
    `ECP_MODE=${shellQuote(mode)}`,
    `ECP_CLIENT_ID=${shellQuote(creds.clientId)}`,
    `ECP_CLIENT_SECRET=${shellQuote(creds.clientSecret)}`,
  ];
  if (agentId) envs.push(`ECP_AGENT_ID=${shellQuote(agentId)}`);
  return envs;
}

export function buildInstallInner(
  base: string,
  mode: InstallMode,
  creds: InstallCreds,
  agentId: string | undefined,
): string {
  const scriptUrl = installScriptUrl(base, mode);
  const envs = buildInstallEnvs(base, mode, creds, agentId);
  return (
    `set -euo pipefail; t=$(mktemp); trap 'rm -f "$t"' EXIT; ` +
    `curl -fsSL --proto '=https' --tlsv1.2 ` +
    `-H ${shellQuote(`CF-Access-Client-Id: ${creds.clientId}`)} ` +
    `-H ${shellQuote(`CF-Access-Client-Secret: ${creds.clientSecret}`)} ` +
    `-o "$t" ${shellQuote(scriptUrl)}; ` +
    `env ${envs.join(" ")} bash "$t"`
  );
}

// One-line install command: runs the installer directly when uid is 0,
// otherwise re-runs the identical command through sudo (the agent service then
// runs as the invoking account; sudo preserves SUDO_USER/SUDO_UID).
export function installOneLineCommand(inner: string): string {
  const bashCmd = `bash -o pipefail -c ${shellQuote(inner)}`;
  return `if [ "$(id -u)" -eq 0 ]; then ${bashCmd}; else sudo ${bashCmd}; fi`;
}

export function buildInstallCommand(
  base: string,
  mode: InstallMode,
  creds: InstallCreds,
  agentId: string | undefined,
): { envs: string[]; inner: string; command: string } {
  const envs = buildInstallEnvs(base, mode, creds, agentId);
  const inner = buildInstallInner(base, mode, creds, agentId);
  const command = installOneLineCommand(inner);
  return { envs, inner, command };
}
