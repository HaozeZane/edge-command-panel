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

// One-line install command: the inner installer body (which embeds the One
// client credentials) is first written to a private 0600 temporary script, so
// sudo's argv only carries `bash <path>` and sudo COMMAND logs cannot record
// the credentials. The identical script runs directly when uid is 0, otherwise
// through sudo (the agent service then runs as the invoking account; sudo
// preserves SUDO_USER/SUDO_UID for the child script). Both the temp script and
// the script's download temp file are removed on success and failure via trap.
export function installOneLineCommand(inner: string): string {
  const bootstrap =
    `set -euo pipefail; umask 077; r=$(mktemp); trap 'rm -f "$r"' EXIT; ` +
    `printf '%s\\n' ${shellQuote(inner)} > "$r"; chmod 600 "$r"; ` +
    `if [ "$(id -u)" -eq 0 ]; then bash "$r"; else sudo bash "$r"; fi`;
  return `bash -o pipefail -c ${shellQuote(bootstrap)}`;
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
