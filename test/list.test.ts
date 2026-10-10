import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { list as gitea, resolve as resolveGitea } from "../src/gitea.ts";
import { list as github, resolve as resolveGithub } from "../src/github.ts";
import { list as gitlab, resolve as resolveGitlab } from "../src/gitlab.ts";
import { list as sourcehut, resolve as resolveSourcehut } from "../src/sourcehut.ts";
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

    expect(resolveGithub()).toEqual({
      token: "gho_second",
      source: "config",
      origin: "gh hosts.yml",
    });
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

  it("keeps the OAuth expiry glab recorded when GitLab accepts the token", async () => {
    writeConfig(
      "glab-cli/config.yml",
      "hosts:\n    gitlab.com:\n        token: glpat-oauth\n        oauth2_expiry_date: 2099-01-01T00:00:00Z\n",
    );
    stubFetch({ "glpat-oauth": () => json({ username: "dev" }) });

    expect(await gitlab({ verify: true })).toMatchObject([
      { state: "valid", account: "dev", expiresAt: Date.parse("2099-01-01T00:00:00Z") },
    ]);
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

/* A stand-in tea answering exact `<args> | <stdin line>;` keys, and failing like tea otherwise. */
function fakeTea(answers: Record<string, string>): void {
  const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
  const cases = Object.entries(answers)
    .map(([call, output]) => `  ${quote(call)}) printf '%s\\n' ${quote(output)} ;;`)
    .join("\n");
  const bin = mkdtempSync(join(tmpdir(), "credentials-bin-"));
  writeFileSync(
    join(bin, "tea"),
    [
      "#!/bin/sh",
      'request=""',
      'while IFS= read -r line && [ -n "$line" ]; do request="$request$line;"; done',
      'case "$* | $request" in',
      cases,
      '  *) echo "Error: user not set" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "tea"), 0o755);
  vi.stubEnv("PATH", bin);
}

/* What `tea login status --output json` prints for one login. */
function teaStatus(name: string, fields: Record<string, string>): string {
  return JSON.stringify([{ name, url: "https://gitea.com", helper: "false", ...fields }]);
}

describe("gitea.list", () => {
  it("never sends GITEA_TOKEN without GITEA_INSTANCE_URL, which names its host", async () => {
    vi.stubEnv("GITEA_TOKEN", "gitea-env");
    stubFetch({});

    expect(await gitea({ verify: true })).toMatchObject([
      {
        host: "any",
        state: "unchecked",
        note: "GITEA_TOKEN names no host without a valid GITEA_INSTANCE_URL, so it is never sent anywhere to check",
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("checks GITEA_TOKEN on GITEA_INSTANCE_URL, as tea pairs them", async () => {
    vi.stubEnv("GITEA_TOKEN", "gitea-env");
    vi.stubEnv("GITEA_INSTANCE_URL", "https://git.home.example:3000/");
    stubFetch({ "gitea-env": () => json({ username: "ops" }) });

    expect(await gitea({ verify: true })).toMatchObject([
      { host: "git.home.example:3000", origin: "GITEA_TOKEN", account: "ops", state: "valid" },
    ]);
    expect(sent).toEqual([
      {
        url: "https://git.home.example:3000/api/v1/user",
        authorization: "token gitea-env",
        redirect: "error",
      },
    ]);
  });

  it("reads token, OAuth and SSH logins through tea, and leaves the OAuth check to tea", async () => {
    writeConfig(
      "tea/config.yml",
      [
        "logins:",
        "    - name: cloud",
        "      url: https://gitea.com",
        '      ssh_key: ""',
        "      user: me",
        "      auth_method: oauth",
        "    - name: signed",
        "      url: https://git.home.example",
        "      ssh_certificate_principal: me",
        "      ssh_agent: true",
        "      user: me",
        "    - name: home",
        "      url: https://git.home.example",
        "      token: tea-home",
        "      user: me",
        "",
      ].join("\n"),
    );
    fakeTea({
      "login helper get | protocol=https;host=gitea.com;":
        "protocol=https\nhost=gitea.com\nusername=me\npassword=tea-oauth",
      "login helper get --login=cloud | protocol=https;host=gitea.com;":
        "protocol=https\nhost=gitea.com\nusername=me\npassword=tea-oauth",
      "login helper get --login=home | protocol=https;host=git.home.example;":
        "protocol=https\nhost=git.home.example\nusername=me\npassword=tea-home",
      "login status --output json -- cloud | ": teaStatus("cloud", {
        user: "me",
        valid: "true",
        auth_method: "oauth",
        token_expiry: "2026-10-07T13:00:00Z",
      }),
    });
    stubFetch({ "tea-home": () => json({ username: "me" }) });

    expect(resolveGitea()).toEqual({ token: "tea-oauth", source: "cli", origin: "tea" });
    expect(await gitea({ verify: true })).toEqual([
      {
        service: "gitea",
        host: "gitea.com",
        source: "cli",
        origin: "tea",
        active: true,
        state: "valid",
        account: "me",
        expiresAt: Date.parse("2026-10-07T13:00:00Z"),
      },
      {
        service: "gitea",
        host: "git.home.example",
        source: "config",
        origin: "tea config.yml",
        active: false,
        state: "unchecked",
        account: "me",
        note: "tea signs its requests with an SSH key for this login, so there's no token to read",
      },
      {
        service: "gitea",
        host: "git.home.example",
        source: "cli",
        origin: "tea",
        active: true,
        state: "valid",
        account: "me",
      },
    ]);
    expect(sent.map((request) => request.authorization)).toEqual(["token tea-home"]);
  });

  it("reports tea's refusal of an OAuth login without guessing why", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: cloud\n    url: https://gitea.com\n    auth_method: oauth\n",
    );
    fakeTea({
      "login helper get --login=cloud | protocol=https;host=gitea.com;":
        "protocol=https\nhost=gitea.com\nusername=me\npassword=tea-oauth",
      "login status --output json -- cloud | ": teaStatus("cloud", {
        valid: "false",
        auth_method: "oauth",
        token_expiry: "",
      }),
    });

    expect(await gitea()).toEqual([
      expect.objectContaining({
        state: "rejected",
        note: "tea login status couldn't log in with it",
      }),
    ]);
    expect((await gitea())[0]).not.toHaveProperty("expiresAt");
  });

  it("still asks tea about an OAuth login whose renewal failed", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: cloud\n    url: https://gitea.com\n    auth_method: oauth\n",
    );
    fakeTea({
      "login status --output json -- cloud | ": teaStatus("cloud", {
        valid: "false",
        auth_method: "oauth",
        token_expiry: "2026-10-07T11:55:00Z",
      }),
    });

    expect(await gitea()).toMatchObject([
      {
        active: false,
        state: "expired",
        expiresAt: Date.parse("2026-10-07T11:55:00Z"),
        note: "the CLI records this login, but no token could be read",
      },
    ]);
  });

  it("finds a login tea's own host match misses, behind an SSH one or on an explicit :443", () => {
    writeConfig(
      "tea/config.yml",
      [
        "logins:",
        "  - name: signed",
        "    url: https://git.home.example",
        "    ssh_certificate_principal: me",
        "  - name: cloud",
        "    url: https://git.home.example:443",
        "    auth_method: oauth",
        "",
      ].join("\n"),
    );
    fakeTea({
      "login helper get --login=cloud | protocol=https;host=git.home.example;":
        "protocol=https\nhost=git.home.example:443\nusername=me\npassword=tea-oauth",
    });

    expect(resolveGitea({ baseURL: "https://git.home.example" })).toEqual({
      token: "tea-oauth",
      source: "cli",
      origin: "tea",
    });
  });

  it("never takes a token tea hands out for a login on another host", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: home\n    url: https://git.home.example\n    token: tea-home\n",
    );
    fakeTea({
      "login helper get --login=home | protocol=https;host=git.home.example;":
        "protocol=https\nhost=gitea.com\nusername=me\npassword=tea-elsewhere",
    });
    stubFetch({ "tea-home": () => json({ username: "me" }) });

    expect(await gitea({ verify: true })).toMatchObject([
      { host: "git.home.example", origin: "tea config.yml", source: "config", state: "valid" },
    ]);
    expect(sent.map((request) => request.authorization)).toEqual(["token tea-home"]);
  });

  it("finds no OAuth token without tea, and reads an expiry tea wrote into the file", async () => {
    const past = Date.parse("2026-10-07T11:00:00Z");
    writeConfig(
      "tea/config.yml",
      [
        "logins:",
        "  - name: cloud",
        "    url: https://gitea.com",
        "    auth_method: oauth",
        "  - name: legacy",
        "    url: https://gitea.com",
        "    token: tea-legacy",
        "    refresh_token: tea-refresh",
        `    token_expiry: ${past / 1000}`,
        "",
      ].join("\n"),
    );
    stubFetch({});

    expect(await gitea({ verify: true })).toMatchObject([
      {
        origin: "tea config.yml",
        active: false,
        state: "unchecked",
        note: "the CLI records this login, but no token could be read",
      },
      { origin: "tea config.yml", active: true, state: "expired", expiresAt: past },
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

  it("tells two ports of one host apart, as tea does", async () => {
    writeConfig(
      "tea/config.yml",
      "logins:\n  - name: a\n    url: https://git.home.example:3000\n    token: tea-a\n  - name: b\n    url: https://git.home.example:4000\n    token: tea-b\n",
    );

    expect(await gitea()).toMatchObject([
      { host: "git.home.example:3000", active: true },
      { host: "git.home.example:4000", active: true },
    ]);
    expect(resolveGitea({ baseURL: "https://git.home.example:4000/api/v1" })).toEqual({
      token: "tea-b",
      source: "config",
      origin: "tea config.yml",
    });
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

describe("resolve origin", () => {
  /* One token per case, so list has exactly one entry to match. */
  it.each([
    {
      name: "a token variable",
      setup: () => vi.stubEnv("GITLAB_PAT", "glpat-env"),
      resolve: resolveGitlab,
      list: gitlab,
    },
    {
      name: "gh hosts.yml",
      setup: () =>
        writeConfig("gh/hosts.yml", "github.com:\n    oauth_token: gho_file\n    user: ori\n"),
      resolve: resolveGithub,
      list: github,
    },
    {
      name: "glab config.yml",
      setup: () =>
        writeConfig("glab-cli/config.yml", "hosts:\n  gitlab.com:\n    token: glpat-file\n"),
      resolve: resolveGitlab,
      list: gitlab,
    },
    {
      name: "tea config.yml",
      setup: () =>
        writeConfig(
          "tea/config.yml",
          "logins:\n  - name: gitea.com\n    url: https://gitea.com\n    token: tea-file\n",
        ),
      resolve: resolveGitea,
      list: gitea,
    },
    {
      name: "hut access-token",
      setup: () => writeConfig("hut/config", 'instance "sr.ht" {\n  access-token "hut-file"\n}\n'),
      resolve: resolveSourcehut,
      list: sourcehut,
    },
    {
      name: "hut access-token-cmd",
      setup: () =>
        writeConfig(
          "hut/config",
          `instance "sr.ht" {\n  access-token-cmd "${process.execPath}" -p '"hut-cmd"'\n}\n`,
        ),
      resolve: resolveSourcehut,
      list: sourcehut,
    },
  ])("names $name the way list names its active entry", async ({ setup, resolve, list }) => {
    setup();
    const active = (await list()).filter((entry) => entry.active);

    expect(active).toHaveLength(1);
    expect(resolve()?.origin).toBe(active[0]?.origin);
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
      'Unknown service "launch pad": use one of github, gitlab, gitea, gitee, sourcehut, bitbucket, azure-devops, pushin, cursor-origin, tangled, cloudflare',
    );
    await expect(listCredentials({ verify: "true" as unknown as boolean })).rejects.toThrow(
      "verify must be true or false",
    );
  });
});
