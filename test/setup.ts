/**
 * Every in-process test starts on an empty machine: no token variables, no gh, glab or
 * cf on PATH, and empty config dirs. Set directly, not through `vi.stubEnv`, so a test's
 * `vi.unstubAllEnvs()` comes back here instead of to the developer's real environment.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "credentials-test-"));

for (const key of [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_CONFIG_DIR",
  "GITLAB_TOKEN",
  "GL_TOKEN",
  "GITLAB_PAT",
  "GITLAB_HOST",
  "GITEA_TOKEN",
  "GITEE_TOKEN",
  "GITEE_ACCESS_TOKEN",
  "GITEE_API_BASE",
  "SRHT_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "AGNTN_CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
]) {
  delete process.env[key];
}
process.env.PATH = home;
process.env.XDG_CONFIG_HOME = home;
