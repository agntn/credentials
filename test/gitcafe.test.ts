import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/gitcafe.ts";

const DAY = 24 * 60 * 60 * 1000;

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* One `cafe.json` host entry, as cafe auth login writes it. */
function meta(apiUrl: string, fields: Readonly<Record<string, unknown>> = {}) {
  return { apiUrl, backend: "file-plaintext", updatedAt: "2026-11-12T00:00:00.000Z", ...fields };
}

/* Write cafe.json and credentials.json the way `cafe auth login --store file` does. */
function cafeLogin(
  hosts: Readonly<Record<string, unknown>>,
  tokens: Readonly<Record<string, unknown>> = {},
  mode = 0o600,
): string {
  const dir = mkdtempSync(join(tmpdir(), "credentials-cafe-"));
  mkdirSync(join(dir, "gitcafe"));
  writeFileSync(join(dir, "gitcafe", "cafe.json"), JSON.stringify({ version: 1, hosts }));
  const credentials = Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => {
      const [protocol, host] = key.startsWith("http://") ? ["http", key.slice(7)] : ["https", key];
      return [`${protocol}\0${host}\0\0cafe/api`, value];
    }),
  );
  const file = join(dir, "gitcafe", "credentials.json");
  writeFileSync(file, JSON.stringify({ version: 1, credentials }));
  chmodSync(file, mode);
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  return dir;
}

/* A stand-in for `cafe auth http credential get` that logs what it was asked and saw. */
function cafeCli(): string {
  const bin = mkdtempSync(join(tmpdir(), "credentials-bin-"));
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "cafe"),
    [
      "#!/bin/sh",
      'while read -r line; do case "$line" in host=*) host=${line#host=} ;; esac; done',
      `printf "%s | %s | %s %s %s\\n" "$*" "$host" "\${CAFE_TOKEN:-no-token}" "\${CAFE_TELEMETRY:-no-trace}" "\${CAFE_GIT_HOST:-no-git-host}" >> "${log}"`,
      'printf "username=x-token\\npassword=%s\\n" "${CAFE_TOKEN:-gct_cli_$host}"',
    ].join("\n"),
  );
  chmodSync(join(bin, "cafe"), 0o755);
  vi.stubEnv("PATH", bin);
  return log;
}

/* What git.cafe answered a made-up token with, byte for byte. */
const AUTHENTICATION_REQUIRED = {
  type: "https://cafe.sh/errors/authentication-required",
  title: "Authentication required",
  status: 401,
  detail: "Valid credentials are required for this operation.",
};

const PRINCIPAL = { actorId: "act_1", handle: "ori", displayName: "Ori", avatarUrl: null };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gitcafe.resolve", () => {
  it("takes the explicit token, then CAFE_TOKEN, then cafe, then its plaintext file", () => {
    cafeLogin({ "git.cafe": meta("https://git.cafe/api") }, { "git.cafe": { token: "gct_file" } });

    expect(resolve()).toEqual({
      token: "gct_file",
      source: "config",
      origin: "cafe credentials.json",
    });
    cafeCli();
    expect(resolve()).toEqual({ token: "gct_cli_git.cafe", source: "cli", origin: "cafe" });
    vi.stubEnv("CAFE_TOKEN", "gct_env");
    expect(resolve()).toEqual({ token: "gct_env", source: "env", origin: "CAFE_TOKEN" });
    expect(resolve({ token: "mine" })).toEqual({
      token: "mine",
      source: "explicit",
      origin: "token",
    });
  });

  it("keeps an empty CAFE_TOKEN as anonymous access", () => {
    cafeCli();
    vi.stubEnv("CAFE_TOKEN", "");

    expect(resolve()).toEqual({ token: "", source: "env", origin: "CAFE_TOKEN" });
  });

  it("asks cafe about one host, with no token, trace or git host of its own to answer with", () => {
    const log = cafeCli();
    vi.stubEnv("CAFE_TELEMETRY", "1");
    vi.stubEnv("CAFE_GIT_HOST", "elsewhere.example");
    vi.stubEnv("CAFE_HOST", "https://cafe.corp.example");

    resolve();
    resolve({ baseURL: "https://api.cafe.corp.example:8443/" });

    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "auth http credential get --host https://git.cafe/api --no-input --no-update-check | git.cafe | no-token no-trace no-git-host",
      "auth http credential get --host https://api.cafe.corp.example:8443/api --no-input --no-update-check | cafe.corp.example:8443 | no-token no-trace no-git-host",
    ]);
  });

  it("reads the saved token filed under the caller's host", () => {
    cafeLogin(
      {
        "git.cafe": meta("https://git.cafe/api"),
        "cafe.corp.example:8443": meta("https://cafe.corp.example:8443/api"),
      },
      { "git.cafe": { token: "gct_public" }, "cafe.corp.example:8443": { token: "gct_corp" } },
    );
    vi.stubEnv("CAFE_HOST", "https://cafe.corp.example:8443");

    expect(resolve()?.token).toBe("gct_public");
    expect(resolve({ baseURL: "https://cafe.corp.example:8443" })?.token).toBe("gct_corp");
    expect(resolve({ baseURL: "https://cafe.corp.example" })).toBeNull();
    expect(resolve({ baseURL: "file:///srv/cafe" })).toBeNull();
  });

  it("reads an http instance's token under its http key", () => {
    cafeLogin(
      { "cafe.internal:8080": meta("http://cafe.internal:8080/api") },
      { "http://cafe.internal:8080": { token: "gct_http" } },
    );

    expect(resolve({ baseURL: "http://cafe.internal:8080" })?.token).toBe("gct_http");
    expect(resolve({ baseURL: "https://cafe.internal:8080" })).toBeNull();
  });

  it("skips what cafe skips: an exposed file, an expired token, a keyring login", () => {
    const login = { "git.cafe": meta("https://git.cafe/api") };
    cafeLogin(login, { "git.cafe": { token: "gct_exposed" } }, 0o644);
    expect(resolve()).toBeNull();

    const expired = new Date(Date.now() - DAY).toISOString();
    cafeLogin(login, { "git.cafe": { token: "gct_old", username: null, expiresAt: expired } });
    expect(resolve()).toBeNull();
    cafeLogin(login, { "git.cafe": { token: "gct_odd", username: null, expiresAt: "soon" } });
    expect(resolve()).toBeNull();

    cafeLogin(
      { "git.cafe": meta("https://git.cafe/api", { backend: "native" }) },
      {
        "git.cafe": { token: "gct_stale" },
      },
    );
    expect(resolve()).toBeNull();
  });

  it("never hands a token filed under another host's apiUrl", () => {
    cafeLogin(
      { "git.cafe": meta("https://evil.example/api") },
      { "git.cafe": { token: "gct_x" }, "evil.example": { token: "gct_evil" } },
    );

    expect(resolve()).toBeNull();
    expect(resolve({ baseURL: "https://evil.example" })).toBeNull();
  });

  it("finds no named account past CAFE_TOKEN", () => {
    cafeCli();

    expect(resolve({ account: "ori" })).toBeNull();
  });
});

describe("gitcafe.list", () => {
  it("lists nothing on a machine without CAFE_TOKEN or cafe", async () => {
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks CAFE_TOKEN as a bearer at git.cafe's /auth/principal", async () => {
    vi.stubEnv("CAFE_TOKEN", "gct_env");
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toEqual([
      {
        service: "gitcafe",
        host: "git.cafe",
        source: "env",
        origin: "CAFE_TOKEN",
        active: true,
        state: "valid",
        account: "ori",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://git.cafe/api/auth/principal"]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer gct_env" });
  });

  it("checks CAFE_TOKEN where CAFE_HOST sends it, and nowhere for a host cafe won't take", async () => {
    vi.stubEnv("CAFE_TOKEN", "gct_corp");
    vi.stubEnv("CAFE_HOST", "cafe.corp.example:8443");
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toMatchObject([{ host: "cafe.corp.example:8443" }]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://cafe.corp.example:8443/api/auth/principal",
    ]);

    vi.stubEnv("CAFE_HOST", "ftp://cafe.corp.example");
    expect(await list({ verify: true })).toEqual([
      expect.objectContaining({
        host: "any",
        state: "unchecked",
        note: "CAFE_TOKEN names no host, so it is never sent anywhere to check",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lists cafe's logins behind CAFE_TOKEN, each checked on its own API", async () => {
    const soon = Date.parse("2027-02-01T00:00:00.000Z");
    cafeLogin(
      {
        "git.cafe": meta("https://git.cafe/api", { backend: "native", username: "ori" }),
        "cafe.corp.example": meta("https://cafe.corp.example/api", {
          username: "o.two",
          expiresAt: new Date(soon).toISOString(),
        }),
      },
      { "cafe.corp.example": { token: "gct_corp", username: null, expiresAt: null } },
    );
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toEqual([
      {
        service: "gitcafe",
        host: "git.cafe",
        source: "config",
        origin: "cafe cafe.json",
        active: false,
        state: "unchecked",
        account: "ori",
        note: "cafe keeps this login in the system keyring, and only cafe can read it there",
      },
      {
        service: "gitcafe",
        host: "cafe.corp.example",
        source: "config",
        origin: "cafe credentials.json",
        active: true,
        state: "valid",
        account: "ori",
        expiresAt: soon,
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://cafe.corp.example/api/auth/principal",
    ]);

    vi.stubEnv("CAFE_TOKEN", "gct_env");
    expect((await list()).map(({ origin, active }) => [origin, active])).toEqual([
      ["CAFE_TOKEN", true],
      ["cafe cafe.json", false],
      ["cafe credentials.json", false],
    ]);
  });

  it("takes keyring logins from cafe, never the CAFE_TOKEN cafe would answer with", async () => {
    cafeLogin({ "git.cafe": meta("https://git.cafe/api", { backend: "native" }) });
    cafeCli();
    vi.stubEnv("CAFE_TOKEN", "gct_env");
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toMatchObject([
      { origin: "CAFE_TOKEN", active: true, state: "valid" },
      { host: "git.cafe", source: "cli", origin: "cafe", active: false, state: "valid" },
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toMatchObject([
      { Authorization: "Bearer gct_env" },
      { Authorization: "Bearer gct_cli_git.cafe" },
    ]);
  });

  it("marks a login past its recorded expiry and never sends it", async () => {
    cafeLogin(
      { "git.cafe": meta("https://git.cafe/api", { expiresAt: "2026-01-01T00:00:00.000Z" }) },
      { "git.cafe": { token: "gct_old" } },
    );
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    expect(await list({ verify: true })).toMatchObject([{ state: "expired", active: false }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dates a plaintext token by its own expiry, the one resolve goes by", async () => {
    const login = { "git.cafe": meta("https://git.cafe/api") };
    const fetch = stubFetch(() => Response.json(PRINCIPAL));

    for (const expiresAt of ["2026-01-01T00:00:00.000Z", "soon"]) {
      cafeLogin(login, { "git.cafe": { token: "gct_old", username: null, expiresAt } });
      expect(resolve()).toBeNull();
      expect(await list({ verify: true })).toMatchObject([{ state: "expired", active: false }]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads git.cafe's 401 as a rejected token and a 403 as nothing known", async () => {
    vi.stubEnv("CAFE_TOKEN", "gct_revoked");
    stubFetch(() => Response.json(AUTHENTICATION_REQUIRED, { status: 401 }));
    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);

    stubFetch(() => new Response(null, { status: 403 }));
    expect(await list({ verify: true })).toMatchObject([
      { state: "unreachable", note: "HTTP 403" },
    ]);
  });
});
