import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import {
  ENCRYPTION_KEY,
  TEST_AUD,
  TEST_ISSUER,
  TEST_JWKS,
  TEST_PUBLIC_URL,
} from "./test/fixtures.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_URL: TEST_PUBLIC_URL,
          ACCESS_TEAM_DOMAIN: TEST_ISSUER,
          ACCESS_UI_AUD: TEST_AUD.ui,
          ACCESS_API_AUD: TEST_AUD.api,
          ACCESS_AGENT_AUD: TEST_AUD.agent,
          ACCESS_ENROLL_AUD: TEST_AUD.enroll,
          ACCESS_API_CLIENT_ID: "api-client",
          ACCESS_JWKS: JSON.stringify(TEST_JWKS),
          CLOUDFLARE_API_TOKEN: "test-api-token",
          CLOUDFLARE_ACCOUNT_ID: "test-account",
          AGENT_ACCESS_APP_ID: "agent-app",
          AGENT_ACCESS_POLICY_ID: "agent-policy",
          ENROLL_ACCESS_APP_ID: "enroll-app",
          ENROLL_ACCESS_POLICY_ID: "enroll-policy",
          CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
          CLOUDFLARE_API_BASE: "http://127.0.0.1:8788/client/v4",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
