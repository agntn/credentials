import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/pushin.ts";

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* Write hosts.json the way pun login does, and point PUN_CONFIG_DIR at it. */
function punHosts(hosts: Readonly<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "credentials-pun-"));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ hosts, aliases: {} }, null, 2));
  vi.stubEnv("PUN_CONFIG_DIR", dir);
  return dir;
}

/* What pushin.eu answered a made-up token with, byte for byte. */
const BAD_CREDENTIALS = {
  message: "Bad credentials",
  documentation_url: "https://pushin.eu/docs/api",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pushin.resolve", () => {
  it("takes the explicit token, then PUSHIN_TOKEN, then pun's saved login", () => {
    punHosts({ "https://pushin.eu": { token: "pun_pat_saved" } });

    expect(resolve()).toEqual({ token: "pun_pat_saved", source: "config" });
    vi.stubEnv("PUSHIN_TOKEN", "pun_pat_env");
    expect(resolve()).toEqual({ token: "pun_pat_env", source: "env" });
    expect(resolve({ token: "mine" })).toEqual({ token: "mine", source: "explicit" });
  });

  it("keeps an empty PUSHIN_TOKEN as anonymous access", () => {
    punHosts({ "https://pushin.eu": { token: "pun_pat_saved" } });
    vi.stubEnv("PUSHIN_TOKEN", "");

    expect(resolve()).toEqual({ token: "", source: "env" });
  });

  it("finds hosts.json under XDG_CONFIG_HOME without PUN_CONFIG_DIR", () => {
    const home = mkdtempSync(join(tmpdir(), "credentials-xdg-"));
    mkdirSync(join(home, "pun"));
    writeFileSync(
      join(home, "pun", "hosts.json"),
      JSON.stringify({ hosts: { "https://pushin.eu/": { token: "pun_pat_xdg" } } }),
    );
    vi.stubEnv("XDG_CONFIG_HOME", home);

    expect(resolve()).toEqual({ token: "pun_pat_xdg", source: "config" });
  });

  it("picks the login by the origin the caller will send the token to", () => {
    punHosts({
      "https://pushin.eu": { token: "pun_pat_public" },
      "https://git.corp.example:8443": { token: "pun_pat_corp" },
    });

    expect(resolve({ baseURL: "https://git.corp.example:8443/api/v1" })).toMatchObject({
      token: "pun_pat_corp",
    });
    expect(resolve({ baseURL: "https://pushin.eu/api/v1" })).toMatchObject({
      token: "pun_pat_public",
    });
    expect(resolve({ baseURL: "https://git.corp.example" })).toBeNull();
    expect(resolve({ baseURL: "https://evil.pushin.eu" })).toBeNull();
  });

  it("never hands a self-hosted login to a caller headed for pushin.eu", () => {
    punHosts({ "https://git.corp.example": { token: "pun_pat_corp" } });
    vi.stubEnv("PUSHIN_URL", "https://git.corp.example");

    expect(resolve()).toBeNull();
  });

  it("reads nothing for a named account, a non-http baseURL or a broken file", () => {
    const dir = punHosts({ "https://pushin.eu": { token: "pun_pat_saved" } });

    expect(resolve({ account: "ori" })).toBeNull();
    expect(resolve({ baseURL: "file:///srv/pushin" })).toBeNull();
    writeFileSync(join(dir, "hosts.json"), "{ not json");
    expect(resolve()).toBeNull();
  });
});

describe("pushin.list", () => {
  it("lists nothing on a machine without PUSHIN_TOKEN or pun", async () => {
    const fetch = stubFetch(() => Response.json({}));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks PUSHIN_TOKEN as a bearer at pushin.eu", async () => {
    vi.stubEnv("PUSHIN_TOKEN", "pun_pat_env");
    const fetch = stubFetch(() => Response.json({ id: 7, login: "ori", type: "User" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "pushin",
        host: "pushin.eu",
        source: "env",
        origin: "PUSHIN_TOKEN",
        active: true,
        state: "valid",
        account: "ori",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://pushin.eu/api/v1/user"]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer pun_pat_env",
    );
  });

  it("checks PUSHIN_TOKEN where PUSHIN_URL sends it, not on pushin.eu", async () => {
    vi.stubEnv("PUSHIN_TOKEN", "pun_pat_corp");
    vi.stubEnv("PUSHIN_URL", "https://git.corp.example:8443/");
    const fetch = stubFetch(() => Response.json({ login: "dev" }));

    expect(await list({ verify: true })).toMatchObject([
      { host: "git.corp.example:8443", account: "dev", state: "valid" },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://git.corp.example:8443/api/v1/user",
    ]);
  });

  it.each(["corp pushin", "file:///srv/pushin"])(
    "sends the token nowhere when PUSHIN_URL %s names no host",
    async (url) => {
      vi.stubEnv("PUSHIN_TOKEN", "pun_pat_env");
      vi.stubEnv("PUSHIN_URL", url);
      const fetch = stubFetch(() => Response.json({ login: "ori" }));

      expect(await list({ verify: true })).toMatchObject([
        {
          host: "any",
          state: "unchecked",
          note: "PUSHIN_TOKEN names no host, so it is never sent anywhere to check",
        },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("lists pun's logins behind PUSHIN_TOKEN, each checked on its own instance", async () => {
    punHosts({
      "https://pushin.eu": { token: "pun_pat_public" },
      "https://pushin.eu/": { token: "pun_pat_shadowed" },
      "https://git.corp.example:8443/": { token: "pun_pat_corp" },
      "ssh://git.corp.example": { token: "pun_pat_ssh" },
      "https://no-token.example": {},
    });
    const fetch = stubFetch(() => Response.json({ login: "ori" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "pushin",
        host: "pushin.eu",
        source: "config",
        origin: "pun hosts.json",
        active: true,
        state: "valid",
        account: "ori",
      },
      expect.objectContaining({ host: "pushin.eu", active: false }),
      expect.objectContaining({ host: "git.corp.example:8443", active: true }),
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://pushin.eu/api/v1/user",
      "https://pushin.eu/api/v1/user",
      "https://git.corp.example:8443/api/v1/user",
    ]);

    vi.stubEnv("PUSHIN_TOKEN", "pun_pat_env");
    const withEnv = await list();
    expect(withEnv.map(({ origin, active }) => [origin, active])).toEqual([
      ["PUSHIN_TOKEN", true],
      ["pun hosts.json", false],
      ["pun hosts.json", false],
      ["pun hosts.json", false],
    ]);
  });

  it("reads pushin.eu's 401 as a rejected token", async () => {
    vi.stubEnv("PUSHIN_TOKEN", "pun_pat_revoked");
    stubFetch(() => Response.json(BAD_CREDENTIALS, { status: 401 }));

    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);
  });
});
