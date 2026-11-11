import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { resolveForge as resolveToken } from "../src/core/forge.ts";

// Mock child_process and fs
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe("resolveToken", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    // Clear all token env vars
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GL_TOKEN;
    delete process.env.GITLAB_PAT;
    delete process.env.GITEA_TOKEN;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // --- Explicit token ---

  describe("explicit token", () => {
    it("returns explicit token when provided", () => {
      const result = resolveToken("github", { token: "my-token" });
      expect(result).toEqual({ token: "my-token", source: "explicit", origin: "token" });
    });

    it("returns explicit token even if empty string", () => {
      const result = resolveToken("github", { token: "" });
      expect(result).toEqual({ token: "", source: "explicit", origin: "token" });
    });

    it("skips env and CLI when explicit token is set", () => {
      process.env.GITHUB_TOKEN = "env-token";
      const result = resolveToken("github", { token: "explicit-token" });
      expect(result!.token).toBe("explicit-token");
      expect(result!.source).toBe("explicit");
    });
  });

  // --- Environment variables ---

  describe("env vars", () => {
    it("resolves GH_TOKEN", () => {
      process.env.GH_TOKEN = "ghp_abc123";
      const result = resolveToken("github");
      expect(result).toEqual({ token: "ghp_abc123", source: "env", origin: "GH_TOKEN" });
    });

    it("resolves GITHUB_TOKEN as fallback", () => {
      process.env.GITHUB_TOKEN = "ghp_fallback";
      const result = resolveToken("github");
      expect(result).toEqual({ token: "ghp_fallback", source: "env", origin: "GITHUB_TOKEN" });
    });

    it("prefers GH_TOKEN over GITHUB_TOKEN", () => {
      process.env.GH_TOKEN = "primary";
      process.env.GITHUB_TOKEN = "fallback";
      const result = resolveToken("github");
      expect(result!.token).toBe("primary");
    });

    it("resolves GITLAB_TOKEN", () => {
      process.env.GITLAB_TOKEN = "glpat-123";
      const result = resolveToken("gitlab");
      expect(result).toEqual({ token: "glpat-123", source: "env", origin: "GITLAB_TOKEN" });
    });

    it("resolves GL_TOKEN as fallback for GitLab", () => {
      process.env.GL_TOKEN = "gl-fallback";
      const result = resolveToken("gitlab");
      expect(result!.token).toBe("gl-fallback");
    });

    it("names the GitLab variable that won, not the whole chain", () => {
      process.env.GITLAB_PAT = "glpat-third";
      expect(resolveToken("gitlab")?.origin).toBe("GITLAB_PAT");
      process.env.GL_TOKEN = "glpat-second";
      expect(resolveToken("gitlab")?.origin).toBe("GL_TOKEN");
    });

    it("resolves GITEA_TOKEN", () => {
      process.env.GITEA_TOKEN = "gitea-abc";
      const result = resolveToken("gitea");
      expect(result).toEqual({ token: "gitea-abc", source: "env", origin: "GITEA_TOKEN" });
    });

    it("stops the chain when env var is empty string", () => {
      process.env.GH_TOKEN = "";
      const result = resolveToken("github");
      expect(result).toEqual({ token: "", source: "env", origin: "GH_TOKEN" });
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  // --- CLI tools ---

  describe("CLI tools", () => {
    it("runs gh auth token for GitHub", () => {
      mockedExecFileSync.mockReturnValueOnce("gho_clitoken\n");
      const result = resolveToken("github");
      expect(result).toEqual({ token: "gho_clitoken", source: "cli", origin: "gh" });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );
    });

    it("uses custom hostname from baseURL", () => {
      mockedExecFileSync.mockReturnValueOnce("gho_enterprise\n");
      const result = resolveToken("github", {
        baseURL: "https://github.corp.example.com/api/v3",
      });
      expect(result!.token).toBe("gho_enterprise");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "github.corp.example.com"],
        expect.any(Object),
      );
    });

    it("returns null when gh CLI fails", () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error("command not found: gh");
      });
      // No config file either
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const result = resolveToken("github");
      expect(result).toBeNull();
    });

    it("runs glab config get token for GitLab", () => {
      mockedExecFileSync.mockReturnValueOnce("glpat-fromcli\n");
      const result = resolveToken("gitlab");
      expect(result).toEqual({ token: "glpat-fromcli", source: "cli", origin: "glab" });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "glab",
        ["config", "get", "token", "--host", "gitlab.com"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );
    });

    it("skips tea CLI (relies on config files)", () => {
      // tea has no simple token command, should fall through to config
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const result = resolveToken("gitea");
      expect(result).toBeNull();
      // execSync should not be called for tea
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  // --- Config files ---

  describe("config files", () => {
    it("reads gh hosts.yml for GitHub", () => {
      // CLI not available
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockedReadFileSync.mockReturnValueOnce(
        "github.com:\n    oauth_token: gho_fromconfig\n    user: testuser\n",
      );
      const result = resolveToken("github");
      expect(result).toEqual({ token: "gho_fromconfig", source: "config", origin: "gh hosts.yml" });
    });

    it("reads gh config for custom hostname", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockedReadFileSync.mockReturnValueOnce(
        "github.enterprise.com:\n    oauth_token: gho_enterprise\n    user: admin\n",
      );
      const result = resolveToken("github", {
        baseURL: "https://github.enterprise.com/api/v3",
      });
      expect(result!.token).toBe("gho_enterprise");
    });

    it("reads glab config for GitLab", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockedReadFileSync.mockReturnValueOnce("hosts:\n  gitlab.com:\n    token: glpat-fromfile\n");
      const result = resolveToken("gitlab");
      expect(result).toEqual({
        token: "glpat-fromfile",
        source: "config",
        origin: "glab config.yml",
      });
    });

    it("reads tea config for Gitea", () => {
      mockedReadFileSync.mockReturnValueOnce(
        "logins:\n  - name: codeberg.org\n    url: https://codeberg.org\n    token: tea-fromfile\n",
      );
      const result = resolveToken("gitea", {
        baseURL: "https://codeberg.org",
      });
      expect(result).toEqual({ token: "tea-fromfile", source: "config", origin: "tea config.yml" });
    });

    it("returns null when no config file exists", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const result = resolveToken("github");
      expect(result).toBeNull();
    });

    it("reads token only from matching host section", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      mockedReadFileSync.mockReturnValueOnce(
        "github.other.com:\n" +
          "  oauth_token: wrong-token\n" +
          "github.com:\n" +
          "  oauth_token: correct-token\n",
      );

      const result = resolveToken("github");
      expect(result).toEqual({ token: "correct-token", source: "config", origin: "gh hosts.yml" });
    });
  });

  // --- Named account ---

  describe("named account", () => {
    const hostsWithTwoAccounts =
      "github.com:\n" +
      "    users:\n" +
      "        active:\n" +
      "            oauth_token: gho_active\n" +
      "        second:\n" +
      "            oauth_token: gho_second\n" +
      "    user: active\n" +
      "    oauth_token: gho_active\n";

    it("asks gh for that login's token", () => {
      mockedExecFileSync.mockReturnValueOnce("gho_second\n");
      const result = resolveToken("github", { account: "second" });
      expect(result).toEqual({ token: "gho_second", source: "cli", origin: "gh" });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "github.com", "--user=second"],
        expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
      );
    });

    it("reads the login's own entry from hosts.yml", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      mockedReadFileSync.mockReturnValueOnce(hostsWithTwoAccounts);
      const result = resolveToken("github", { account: "second" });
      expect(result).toEqual({ token: "gho_second", source: "config", origin: "gh hosts.yml" });
    });

    it("never falls back to the active account's token", () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("no account found for missing");
      });
      mockedReadFileSync.mockReturnValueOnce(hostsWithTwoAccounts);
      expect(resolveToken("github", { account: "missing" })).toBeNull();
    });

    it("leaves the env step first", () => {
      process.env.GH_TOKEN = "ghp_env";
      expect(resolveToken("github", { account: "second" })).toEqual({
        token: "ghp_env",
        source: "env",
        origin: "GH_TOKEN",
      });
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it("finds nothing on platforms whose CLI cannot pick a login", () => {
      mockedReadFileSync.mockReturnValue("hosts:\n  gitlab.com:\n    token: glpat-active\n");
      expect(resolveToken("gitlab", { account: "second" })).toBeNull();
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  // --- Priority chain ---

  describe("priority", () => {
    it("explicit > env > cli > config", () => {
      process.env.GITHUB_TOKEN = "env-token";
      mockedExecFileSync.mockReturnValue("cli-token\n");

      // Explicit wins over all
      const r1 = resolveToken("github", { token: "explicit" });
      expect(r1!.source).toBe("explicit");

      // Env wins when no explicit
      const r2 = resolveToken("github");
      expect(r2!.source).toBe("env");

      // CLI wins when no env
      delete process.env.GITHUB_TOKEN;
      const r3 = resolveToken("github");
      expect(r3!.source).toBe("cli");
    });
  });

  // --- Default hostnames ---

  describe("hostname extraction", () => {
    it("defaults to github.com for GitHub", () => {
      mockedExecFileSync.mockReturnValueOnce("token\n");
      resolveToken("github");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        expect.any(Object),
      );
    });

    it("defaults to gitlab.com for GitLab", () => {
      mockedExecFileSync.mockReturnValueOnce("token\n");
      resolveToken("gitlab");
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "glab",
        ["config", "get", "token", "--host", "gitlab.com"],
        expect.any(Object),
      );
    });

    it("extracts hostname from baseURL", () => {
      mockedExecFileSync.mockReturnValueOnce("token\n");
      resolveToken("github", { baseURL: "https://git.mycompany.com/api/v3" });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        "gh",
        ["auth", "token", "--hostname", "git.mycompany.com"],
        expect.any(Object),
      );
    });
  });
});

describe("forge subpaths", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GL_TOKEN;
    delete process.env.GITLAB_PAT;
    delete process.env.GITEA_TOKEN;
  });

  it("route each forge to its own chain", async () => {
    process.env.GH_TOKEN = "gh";
    process.env.GITLAB_TOKEN = "gl";
    process.env.GITEA_TOKEN = "tea";
    const [github, gitlab, gitea] = await Promise.all([
      import("../src/github.ts"),
      import("../src/gitlab.ts"),
      import("../src/gitea.ts"),
    ]);

    expect(github.resolve()).toEqual({ token: "gh", source: "env", origin: "GH_TOKEN" });
    expect(gitlab.resolve()).toEqual({ token: "gl", source: "env", origin: "GITLAB_TOKEN" });
    expect(gitea.resolve()).toEqual({ token: "tea", source: "env", origin: "GITEA_TOKEN" });
  });
});

describe("gh account argument", () => {
  it("passes the account glued to --user, so a leading dash stays a value", async () => {
    vi.resetAllMocks();
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    vi.mocked(execFileSync).mockReturnValueOnce("tok\n");
    const { resolve } = await import("../src/github.ts");

    resolve({ account: "--hostname=evil.example" });

    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual([
      "auth",
      "token",
      "--hostname",
      "github.com",
      "--user=--hostname=evil.example",
    ]);
  });
});

describe("CLI token variables", () => {
  it("runs glab without the variables it would print instead of a login", async () => {
    vi.resetAllMocks();
    for (const key of ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_PAT"]) delete process.env[key];
    process.env.OAUTH_TOKEN = "oauth-env";
    process.env.GITLAB_ACCESS_TOKEN = "access-env";
    vi.mocked(execFileSync).mockReturnValueOnce("glpat-login\n");
    try {
      const { resolve } = await import("../src/gitlab.ts");

      expect(resolve()).toEqual({ token: "glpat-login", source: "cli", origin: "glab" });
      const options = vi.mocked(execFileSync).mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env).not.toHaveProperty("OAUTH_TOKEN");
      expect(options.env).not.toHaveProperty("GITLAB_ACCESS_TOKEN");
    } finally {
      delete process.env.OAUTH_TOKEN;
      delete process.env.GITLAB_ACCESS_TOKEN;
    }
  });
});
