import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/cursor-origin.ts";

const HOUR = 60 * 60 * 1000;

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* A moment in whole seconds, the precision of a JWT `exp`. */
function seconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/* An unsigned JWT that expires at `expiresAt`, enough for `exp` to be read. */
function jwt(expiresAt: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ sub: "user_1", exp: expiresAt / 1000 })}.sig`;
}

/* Write credentials.json the way origin auth login does, under the isolated XDG dir. */
function originLogin(fields: Readonly<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "credentials-origin-"));
  mkdirSync(join(dir, "origin-cli"));
  writeFileSync(
    join(dir, "origin-cli", "credentials.json"),
    JSON.stringify({
      refreshToken: "refresh",
      authMethod: "login",
      endpoint: "https://api2.cursor.sh",
      ...fields,
    }),
  );
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  return dir;
}

/*
 * A stand-in for `origin auth token`. The real one prints CURSOR_AUTH_TOKEN when it is set,
 * and answers for whatever host CURSOR_ORIGIN_ENDPOINT names, so both show up in the output.
 */
function originCli(): void {
  const bin = mkdtempSync(join(tmpdir(), "credentials-bin-"));
  writeFileSync(
    join(bin, "origin"),
    '#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 2\nprintf "%s\\n" "${CURSOR_AUTH_TOKEN:-cli-${CURSOR_ORIGIN_ENDPOINT:-default}}"\n',
  );
  chmodSync(join(bin, "origin"), 0o755);
  vi.stubEnv("PATH", bin);
}

/* What api.cursor.com answered a made-up bearer with. */
const UNAUTHENTICATED = {
  code: 16,
  message:
    "Request is missing valid authentication credentials. Provide a Bearer token in the Authorization header.",
  details: [
    {
      "@type": "type.googleapis.com/google.rpc.RequestInfo",
      requestId: "8404cd62-f8a1-4ca6-94b9-794a6ab3114d",
    },
  ],
};

const RATE_LIMIT = {
  resources: { core: { limit: 6000, remaining: 5994, reset: 1785682800, used: 6 } },
  rate: { limit: 6000, remaining: 5994, reset: 1785682800, used: 6 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("cursorOrigin.resolve", () => {
  it("takes the explicit token, then CURSOR_AUTH_TOKEN, then origin, then its saved login", () => {
    const fresh = jwt(Date.now() + HOUR);
    originLogin({ accessToken: fresh });

    expect(resolve()).toEqual({
      token: fresh,
      source: "config",
      origin: "origin credentials.json",
    });
    originCli();
    expect(resolve()).toEqual({ token: "cli-default", source: "cli", origin: "origin" });
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");
    expect(resolve()).toEqual({ token: "oat_env", source: "env", origin: "CURSOR_AUTH_TOKEN" });
    expect(resolve({ token: "mine" })).toEqual({
      token: "mine",
      source: "explicit",
      origin: "token",
    });
  });

  it("asks origin about origin.cursor.com, whatever CURSOR_ORIGIN_ENDPOINT says", () => {
    originCli();
    vi.stubEnv("CURSOR_ORIGIN_ENDPOINT", "https://origin.corp.example");

    expect(resolve()).toEqual({ token: "cli-default", source: "cli", origin: "origin" });
  });

  it("keeps an empty CURSOR_AUTH_TOKEN as anonymous access", () => {
    originCli();
    vi.stubEnv("CURSOR_AUTH_TOKEN", "");

    expect(resolve()).toEqual({ token: "", source: "env", origin: "CURSOR_AUTH_TOKEN" });
  });

  it("reads logins only for a caller headed to origin.cursor.com", () => {
    originCli();

    for (const baseURL of [
      "https://api.cursor.com",
      "https://api.cursor.com/v1/origin",
      "https://origin.cursor.com",
      "https://api.origin.cursor.com",
    ]) {
      expect(resolve({ baseURL })).toEqual({
        token: "cli-default",
        source: "cli",
        origin: "origin",
      });
    }
    expect(resolve({ baseURL: "https://origin.corp.example" })).toBeNull();
    expect(resolve({ baseURL: "https://evilorigin.cursor.com" })).toBeNull();
    expect(resolve({ baseURL: "http://api.cursor.com" })).toBeNull();
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");
    expect(resolve({ baseURL: "https://origin.corp.example" })).toMatchObject({ source: "env" });
  });

  it("leaves the saved login alone once CURSOR_API_KEY is set, as origin does", () => {
    originLogin({ accessToken: jwt(Date.now() + HOUR) });
    vi.stubEnv("CURSOR_API_KEY", "key_without_origin");

    expect(resolve()).toBeNull();
  });

  it("gives a baseURL outside origin.cursor.com no saved login, even with that host name", () => {
    originLogin({ accessToken: jwt(Date.now() + HOUR) });

    expect(resolve({ baseURL: "http://origin.cursor.com" })).toBeNull();
    expect(resolve({ baseURL: "not a url" })).toBeNull();
    expect(resolve({ baseURL: "http://origin.cursor.com", token: "mine" })).toMatchObject({
      source: "explicit",
    });
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");
    expect(resolve({ baseURL: "not a url" })).toEqual({
      token: "oat_env",
      source: "env",
      origin: "CURSOR_AUTH_TOKEN",
    });
  });

  it("skips a saved token that has expired, since only origin can refresh it", () => {
    originLogin({ accessToken: jwt(Date.now() - 1000) });

    expect(resolve()).toBeNull();
  });

  it("reads nothing for a named account, a local dev login or a file origin would refuse", () => {
    const fresh = jwt(Date.now() + HOUR);
    originLogin({ accessToken: fresh });
    expect(resolve({ account: "ori" })).toBeNull();

    originLogin({ accessToken: fresh, endpoint: "http://localhost:8080" });
    expect(resolve()).toBeNull();
    originLogin({ accessToken: fresh, refreshToken: undefined });
    expect(resolve()).toBeNull();
    originLogin({ accessToken: fresh, authMethod: "magic" });
    expect(resolve()).toBeNull();
    const dir = originLogin({ accessToken: fresh });
    writeFileSync(join(dir, "origin-cli", "credentials.json"), "{ not json");
    expect(resolve()).toBeNull();
  });

  it("finds the file under ~/.config/origin-cli first, as origin does once it exists", () => {
    const home = mkdtempSync(join(tmpdir(), "credentials-home-"));
    mkdirSync(join(home, ".config", "origin-cli"), { recursive: true });
    writeFileSync(
      join(home, ".config", "origin-cli", "credentials.json"),
      JSON.stringify({
        accessToken: "oat_legacy",
        refreshToken: "refresh",
        authMethod: "api-key",
        endpoint: "https://api2.cursor.sh",
      }),
    );
    originLogin({ accessToken: "oat_xdg" });
    vi.stubEnv("HOME", home);

    expect(resolve()).toEqual({
      token: "oat_legacy",
      source: "config",
      origin: "origin credentials.json",
    });
  });
});

describe("cursorOrigin.list", () => {
  it("lists nothing on a machine without Cursor variables or origin", async () => {
    const fetch = stubFetch(() => Response.json({}));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks CURSOR_AUTH_TOKEN as a bearer at the rate limit endpoint", async () => {
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");
    const fetch = stubFetch(() => Response.json(RATE_LIMIT));

    expect(await list({ verify: true })).toEqual([
      {
        service: "cursor-origin",
        host: "origin.cursor.com",
        source: "env",
        origin: "CURSOR_AUTH_TOKEN",
        active: true,
        state: "valid",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.cursor.com/v1/origin/rate_limit",
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer oat_env",
    );
  });

  it("reads Origin's 401 as a rejection and its 403 as a check that told nothing", async () => {
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_bad");
    stubFetch(() => Response.json(UNAUTHENTICATED, { status: 401 }));
    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);

    stubFetch(() => Response.json({ code: 7, message: "denied" }, { status: 403 }));
    expect(await list({ verify: true })).toMatchObject([
      { state: "unreachable", note: "HTTP 403" },
    ]);
  });

  it("sends CURSOR_AUTH_TOKEN only to an endpoint origin itself would trust", async () => {
    const fetch = stubFetch(() => Response.json(RATE_LIMIT));
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");

    vi.stubEnv("CURSOR_ORIGIN_ENDPOINT", "https://api.origin.cursor.com");
    expect(await list({ verify: true })).toMatchObject([{ host: "origin.cursor.com" }]);
    vi.stubEnv("CURSOR_ORIGIN_ENDPOINT", "https://api.origin-staging.cursor.com");
    expect(await list({ verify: true })).toMatchObject([{ host: "api.origin-staging.cursor.com" }]);
    vi.stubEnv("CURSOR_ORIGIN_ENDPOINT", "http://localhost:8443");
    expect(await list({ verify: true })).toMatchObject([{ host: "localhost:8443" }]);
    for (const endpoint of [
      "https://origin.corp.example",
      "https://evilorigin.cursor.com",
      "http://api.origin.cursor.com",
      "file:///srv/origin",
    ]) {
      vi.stubEnv("CURSOR_ORIGIN_ENDPOINT", endpoint);
      expect(await list({ verify: true })).toMatchObject([{ host: "any", state: "unchecked" }]);
    }

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.cursor.com/v1/origin/rate_limit",
      "https://api.origin-staging.cursor.com/v1/origin/rate_limit",
      "http://localhost:8443/v1/origin/rate_limit",
    ]);
  });

  it("lists the saved login with its expiry and checks it while it is fresh", async () => {
    const expiresAt = seconds(Date.now() + HOUR);
    originLogin({ accessToken: jwt(expiresAt) });
    const fetch = stubFetch(() => Response.json(RATE_LIMIT));

    expect(await list({ verify: true })).toEqual([
      {
        service: "cursor-origin",
        host: "origin.cursor.com",
        source: "config",
        origin: "origin credentials.json",
        active: true,
        state: "valid",
        expiresAt,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks an expired saved token, says origin refreshes it, and never sends it", async () => {
    const expiresAt = seconds(Date.now() - 2000);
    originLogin({ accessToken: jwt(expiresAt) });
    const fetch = stubFetch(() => Response.json(RATE_LIMIT));

    expect(await list({ verify: true })).toMatchObject([
      {
        state: "expired",
        expiresAt,
        note: "the saved access token has expired, and the next origin command refreshes it",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("puts CURSOR_API_KEY ahead of the saved login and never sends the key", async () => {
    originLogin({ accessToken: jwt(Date.now() + HOUR) });
    vi.stubEnv("CURSOR_API_KEY", "key_secret");
    const fetch = stubFetch(() => Response.json(RATE_LIMIT));

    const entries = await list({ verify: true });

    expect(entries).toMatchObject([
      { origin: "CURSOR_API_KEY", source: "cli", active: true, state: "unchecked" },
      { origin: "origin credentials.json", active: false, state: "valid" },
    ]);
    expect(entries[0]?.note).toContain("never sent anywhere");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(entries)).not.toContain("key_secret");
  });

  it("lets CURSOR_AUTH_TOKEN win over the key and the saved login", async () => {
    originLogin({ accessToken: jwt(Date.now() + HOUR) });
    vi.stubEnv("CURSOR_API_KEY", "key_secret");
    vi.stubEnv("CURSOR_AUTH_TOKEN", "oat_env");

    expect((await list()).map(({ origin, active }) => [origin, active])).toEqual([
      ["CURSOR_AUTH_TOKEN", true],
      ["CURSOR_API_KEY", false],
      ["origin credentials.json", false],
    ]);
  });
});
