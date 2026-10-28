#!/usr/bin/env node
import { downloadAgentRelease } from "./agent-release.mjs";

/**
 * Stage the fixed Agent release. The Web source tree never compiles Go and
 * never reads a GitHub token: this is a public anonymous release download that
 * is verified against agent-release.json before anything is staged.
 */
export async function buildAgent(options = {}) {
  const result = await downloadAgentRelease(options);
  console.log(
    `agent release ${result.tag} verified and staged in frontend/dist/downloads`,
  );
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildAgent();
}
