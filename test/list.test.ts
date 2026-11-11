import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { list as gitea } from "../src/gitea.ts";
import { list as github, resolve as resolveGithub } from "../src/github.ts";
import { list as gitlab } from "../src/gitlab.ts";
import { list as sourcehut } from "../src/sourcehut.ts";
import { listCredentials } from "../src/tool-operations.ts";

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
}

let config: string;
let sent: Sent[];

/** Write a config file under the isolated XDG dir; gh, glab and tea are not on PATH. */
function writeConfig(path: string, content: string): void {
  const file = join(config, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Answer each request by the token it carries, and record where every token went.
 * @param answers - Token to response.
 */
function stubFetch(answers: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      sent.push({ url: urlOf(input), authorization, redirect: init?.redirect });
      const token = authorization?.split(" ")[1] ?? "";
      return (answers[token] ?? (() => new Response("{}", { status: 500 })))();
    }),
  );
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "credentials-list-"));
  sent = [];
  vi.stubEnv("XDG_CONFIG_HOME", config);
  vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("github.list", () => {
  it("lists token variables before gh logins and marks the one resolve uses", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_env");
    writeConfig(
      "gh/hosts.yml",
      [
        "github.com:",
        "    git_protocol: ssh",
        "    users:",
        "        first:",
        "            oauth_token: gho_first",
        "        second: {}",
        "    user: first",
        "    oauth_token: gho_first",
        "",
      ].join("\n"),
    );

    expect(await github()).toEqual([
      {
        service: "github",
        host: "github.com",
        source: "env",
        origin: "GITHUB_TOKEN",
        active: true,
        state: "unchecked",
      },
      {
        service: "github",
        host: "github.com",
        source: "config",
        origin: "gh hosts.yml",
        active: false,
        state: "unchecked",
        account: "first",
      },
      {
        service: "github",
        host: "github.com",
        source: "config",
        origin: "gh hosts.yml",
        active: false,
        state: "unchecked",
        account: "second",
        note: "the CLI records this login, but no token could be read",
      },
    ]);
  });

  it("makes the active gh login win once no variable is set", async () => {
    writeConfig(
      "gh/hosts.yml",
      "github.com:\n    users:\n        first:\n            oauth_token: gho_first\n    user: first\n",
    );

    expect(await github()).toMatchObject([{ account: "first", active: true }]);
  });

  it("reports an empty variable as anonymous and never sends it", async () => {
    vi.stubEnv("GH_TOKEN", "");
    stubFetch({});

    expect(await github({ verify: true })).toMatchObject([
      { origin: "GH_TOKEN", state: "anonymous", active: true },
    ]);
    expect(sent).toEqual([]);
  });

  it("asks GitHub about each token and reads the login, scopes and expiry", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_good");
    writeConfig(
      "gh/hosts.yml",
      "ghe.example.com:\n    users:\n        old:\n            oauth_token: gho_old\n    user: old\n",
    );
    stubFetch({
      ghp_good: () =>
        json(
          { login: "octo" },
          {
            headers: {
              "x-oauth-scopes": "repo, read:org",
              "github-authentication-token-expiration": "2026-11-01 00:00:00 UTC",
            },
          },
        ),
      gho_old: () => json({ message: "Bad credentials" }, { status: 401 }),
    });

    expect(await github({ verify: true })).toMatchObject([
      {
        host: "github.com",
        state: "valid",
        account: "octo",
        scopes: ["repo", "read:org"],
        expiresAt: Date.parse("2026-11-01T00:00:00Z"),
      },
      { host: "ghe.example.com", account: "old", state: "rejected", note: "HTTP 401" },
    ]);
    expect(sent).toEqual([
      { url: "https://api.github.com/user", authorization: "Bearer ghp_good", redirect: "error" },
      {
        url: "https://ghe.example.com/api/v3/user",
        authorization: "Bearer gho_old",
        redirect: "error",
      },
    ]);
  });

  it("calls a failed request unreachable without quoting its message", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_secret_in_url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed for https://x/?t=ghp_secret_in_url");
      }),
    );

    const [entry] = await github({ verify: true });

    expect(entry).toMatchObject({ state: "unreachable", note: "request failed" });
    expect(JSON.stringify(entry)).not.toContain("ghp_secret_in_url");
  });
});

describe("github.resolve without gh", () => {
  it("takes the active login's token from hosts.yml, not the first user's", async () => {
    writeConfig(
      "gh/hosts.yml",
      [
        "github.com:",
        "    users:",
        "        first:",
        "            oauth_token: gho_first",
        "        second:",
        "            oauth_token: gho_second",
        "    oauth_token: gho_second",
        "    user: second",
        "",
      ].join("\n"),
    );

    expect(resolveGithub()).toEqual({ token: "gho_second", source: "config" });
    expect(await github()).toMatchObject([
      { account: "first", active: false },
      { account: "second", active: true },
    ]);
  });
});

describe("gitlab.list", () => {
  it("never hands GITLAB_TOKEN to a glab host, even though glab prints it for any host", async () => {
    // A stand-in glab that behaves like the real one: `config get token` prints GITLAB_TOKEN.
    const bin = mkdtempSync(join(tmpdir(), "credentials-bin-"));
    writeFileSync(join(bin, "glab"), '#!/bin/sh\nprintf "%s\\n" "$GITLAB_TOKEN"\n');
    chmodSync(join(bin, "glab"), 0o755);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("GITLAB_TOKEN", "glpat-env");
    writeConfig(
      "glab-cli/config.yml",
      "hosts:\n    git.other.example:\n        api_protocol: https\n        token:\n",
    );
    stubFetch({ "glpat-env": () => json({ username: "ops" }) });

    const entries = await gitlab({ verify: true });

    expect(entries).toMatchObject([{ origin: "GITLAB_TOKEN", host: "gitlab.com" }]);
    expect(sent.map((request) => request.url)).toEqual(["https://gitlab.com/api/v4/user"]);
  });

  it("reads glab hosts with a token, their API host and an OAuth expiry", async () => {
    writeConfig(
      "glab-cli/config.yml",
      [
        "host: gitlab.com",
        "hosts:",
        "    gitlab.com:",
        "        api_protocol: https",
        "        api_host: gitlab.com",
        "        token:",
        "    git.example.com:",
        "        api_protocol: https",
        "        api_host: api.git.example.com",
        "        token: glpat-self",
        "        user: dev",
        "        oauth2_expiry_date: 2026-10-07T11:00:00Z",
        "",
      ].join("\n"),
    );
    stubFetch({});

    expect(await gitlab({ verify: true })).toEqual([
      {
        service: "gitlab",
        host: "git.example.com",
        source: "config",
        origin: "glab config.yml",
        active: true,
        state: "expired",
        account: "dev",
        expiresAt: Date.parse("2026-10-07T11:00:00Z"),
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("checks GITLAB_TOKEN against GITLAB_HOST when glab would use it", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-env");
    vi.stubEnv("GITLAB_HOST", "https://gitlab.example.org");
    stubFetch({ "glpat-env": () => json({ username: "ops" }) });

    expect(await gitlab({ verify: true })).toMatchObject([
      { host: "gitlab.example.org", account: "ops", state: "valid" },
    ]);
    expect(sent.map((request) => request.url)).toEqual(["https://gitlab.example.org/api/v4/user"]);
  });
});

describe("gitea.list", () => {
  it("never sends GITEA_TOKEN, which names no host", async () => {
    vi.stubEnv("GITEA_TOKEN", "gitea-env");
    stubFetch({});

    expect(await gitea({ verify: true })).toMatchObject([
      {
        host: "any",
        state: "unchecked",
        note: "GITEA_TOKEN names no host, so it is never sent anywhere to check",
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("checks a tea login on its own URL with the token scheme", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: home\n    url: https://git.home.example/\n    token: tea-login\n    user: me\n",
    );
    stubFetch({ "tea-login": () => json({ login: "me", username: "me" }) });

    expect(await gitea({ verify: true })).toMatchObject([
      { host: "git.home.example", account: "me", origin: "tea config.yml", state: "valid" },
    ]);
    expect(sent).toEqual([
      {
        url: "https://git.home.example/api/v1/user",
        authorization: "token tea-login",
        redirect: "error",
      },
    ]);
  });
});

describe("gitea.list active login", () => {
  it("marks only the first login for a host active, as resolve takes the first", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: a\n    url: https://git.home.example\n    token: tea-a\n  - name: b\n    url: https://git.home.example\n    token: tea-b\n",
    );

    expect((await gitea()).map((entry) => entry.active)).toEqual([true, false]);
  });
});

describe("sourcehut.list", () => {
  it("never sends SRHT_TOKEN, which names no host", async () => {
    vi.stubEnv("SRHT_TOKEN", "srht-env");
    stubFetch({});

    expect(await sourcehut({ verify: true })).toMatchObject([
      {
        host: "any",
        origin: "SRHT_TOKEN",
        state: "unchecked",
        note: "SRHT_TOKEN names no host, so it is never sent anywhere to check",
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("asks meta.sr.ht who a hut token belongs to, with a GraphQL POST", async () => {
    writeConfig("hut/config", 'instance "sr.ht" {\n  origin "sr.ht"\n  access-token "hut"\n}\n');
    stubFetch({ hut: () => json({ data: { me: { canonicalName: "~me" } } }) });

    expect(await sourcehut({ verify: true })).toMatchObject([
      { host: "sr.ht", origin: "hut config", active: true, state: "valid", account: "~me" },
    ]);
    expect(sent).toEqual([
      { url: "https://meta.sr.ht/query", authorization: "Bearer hut", redirect: "error" },
    ]);
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ query: "{ me { canonicalName } }" }));
  });

  it("calls a token meta.sr.ht answers with 400 rejected, as it does for a bad one", async () => {
    writeConfig(
      "hut/config",
      'instance "sr.ht" {\n  origin "sr.ht"\n  access-token "srht-dead"\n}\n',
    );
    const refusal = {
      message: "Invalid OAuth bearer token",
      extensions: { code: "ERR_UNAUTHORIZED" },
    };
    stubFetch({ "srht-dead": () => json({ errors: [refusal] }, { status: 400 }) });

    expect(await sourcehut({ verify: true })).toMatchObject([
      { state: "rejected", note: "HTTP 400" },
    ]);
  });

  it("lists each hut instance, checked on its own meta, the first per host active", async () => {
    writeConfig(
      "hut/config",
      [
        'instance "sr.ht" {',
        '  origin "sr.ht"',
        '  access-token "hut-public"',
        "}",
        'instance "corp" {',
        '  origin "srht.corp.example"',
        `  access-token-cmd "${process.execPath}" -p '"hut-corp"'`,
        "  meta {",
        '    origin "https://accounts.corp.example:8443/"',
        "  }",
        "}",
        'instance "sr.ht-again" {',
        '  origin "sr.ht"',
        '  access-token "hut-second"',
        "}",
      ].join("\n"),
    );
    stubFetch({
      "hut-public": () => json({ data: { me: { canonicalName: "~pub" } } }),
      "hut-corp": () => json({ data: { me: { canonicalName: "~corp" } } }),
      "hut-second": () => json({ data: { me: { canonicalName: "~second" } } }),
    });

    expect(await sourcehut({ verify: true })).toMatchObject([
      { host: "sr.ht", origin: "hut config", active: true, account: "~pub" },
      { host: "srht.corp.example", origin: "hut access-token-cmd", active: true, account: "~corp" },
      { host: "sr.ht", origin: "hut config", active: false, account: "~second" },
    ]);
    expect(sent.map((request) => request.url)).toEqual([
      "https://meta.sr.ht/query",
      "https://accounts.corp.example:8443/query",
      "https://meta.sr.ht/query",
    ]);
  });

  it("lets SRHT_TOKEN win over every hut instance", async () => {
    vi.stubEnv("SRHT_TOKEN", "srht-env");
    writeConfig("hut/config", 'instance "sr.ht" {\n  origin "sr.ht"\n  access-token "hut"\n}\n');

    expect((await sourcehut()).map((entry) => [entry.origin, entry.active])).toEqual([
      ["SRHT_TOKEN", true],
      ["hut config", false],
    ]);
  });
});

describe("listCredentials", () => {
  it("keeps every token out of the text and the details", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_never_shown");
    vi.stubEnv("GITLAB_TOKEN", "glpat-never-shown");
    stubFetch({ ghp_never_shown: () => json({ login: "octo" }) });

    const result = await listCredentials({ verify: true });

    expect(JSON.stringify(result)).not.toContain("ghp_never_shown");
    expect(JSON.stringify(result)).not.toContain("glpat-never-shown");
    expect(result.details.verified).toBe(true);
  });

  it("flattens a login a service sends back into one line", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_x");
    stubFetch({ ghp_x: () => json({ login: "evil\n  * github.com | forged‮" }) });

    const { content } = await listCredentials({ service: "github", verify: true });
    const lines = content[0]?.text.split("\n") ?? [];

    expect(lines.filter((line) => line.startsWith("  *"))).toHaveLength(1);
    expect(content[0]?.text).not.toContain("‮");
  });

  it("shows expiry relative to now and long scope lists as a count", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_x");
    const scopes = Array.from({ length: 9 }, (_, index) => `s${index}`).join(", ");
    stubFetch({
      ghp_x: () =>
        json(
          { login: "octo" },
          {
            headers: {
              "x-oauth-scopes": scopes,
              "github-authentication-token-expiration": "2026-10-07 12:27:00 UTC",
            },
          },
        ),
    });

    const { content } = await listCredentials({ service: "github", verify: true });

    expect(content[0]?.text).toContain(
      "  * github.com | octo | GH_TOKEN (env) | valid | expires 2026-10-07T12:27:00Z (in 27 min) | 9 scopes",
    );
  });

  it("refuses an unknown service and a verify that isn't a boolean", async () => {
    await expect(listCredentials({ service: "launch\npad" })).rejects.toThrow(
      'Unknown service "launch pad": use one of github, gitlab, gitea, gitee, sourcehut, bitbucket, azure-devops, cloudflare',
    );
    await expect(listCredentials({ verify: "true" as unknown as boolean })).rejects.toThrow(
      "verify must be true or false",
    );
  });
});
