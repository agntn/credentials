import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/bitbucket.ts";

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* The Authorization header of one recorded call. */
function authorization(fetch: ReturnType<typeof stubFetch>, call = 0): string | null {
  return new Headers(fetch.mock.calls[call]?.[1]?.headers).get("authorization");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("bitbucket.resolve", () => {
  it("takes the explicit token, then BITBUCKET_TOKEN, then the API token with its email", () => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    vi.stubEnv("BITBUCKET_EMAIL", "ori@example.com");

    expect(resolve()).toEqual({ token: "ATATT-api", source: "env", username: "ori@example.com" });
    vi.stubEnv("BITBUCKET_TOKEN", "ATCTT-access");
    expect(resolve()).toEqual({ token: "ATCTT-access", source: "env" });
    expect(resolve({ token: "mine" })).toEqual({ token: "mine", source: "explicit" });
  });

  it("hands an explicit username back beside the explicit token", () => {
    expect(resolve({ token: "ATATT-api", username: "ori@example.com" })).toEqual({
      token: "ATATT-api",
      source: "explicit",
      username: "ori@example.com",
    });
    expect(resolve({ username: "ori@example.com" })).toBeNull();
  });

  it.each([undefined, ""])("skips an API token whose email is %j", (email) => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    if (email !== undefined) vi.stubEnv("BITBUCKET_EMAIL", email);

    expect(resolve()).toBeNull();
  });

  it("keeps an empty BITBUCKET_TOKEN as anonymous access", () => {
    vi.stubEnv("BITBUCKET_TOKEN", "");
    vi.stubEnv("BITBUCKET_API_TOKEN", "never-reached");
    vi.stubEnv("BITBUCKET_EMAIL", "ori@example.com");

    expect(resolve()).toEqual({ token: "", source: "env" });
  });

  it("finds nothing without a variable, since Bitbucket has no CLI login to read", () => {
    expect(resolve()).toBeNull();
    expect(resolve({ baseURL: "https://bitbucket.org", account: "ori" })).toBeNull();
  });
});

describe("bitbucket.list", () => {
  it("lists nothing on a machine without a token variable", async () => {
    const fetch = stubFetch(() => Response.json({}));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the API token as basic auth and never sends the access token", async () => {
    vi.stubEnv("BITBUCKET_TOKEN", "ATCTT-access");
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    vi.stubEnv("BITBUCKET_EMAIL", "ori@example.com");
    const fetch = stubFetch(() => Response.json({ username: "oritwoen", nickname: "Ori" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "bitbucket",
        host: "bitbucket.org",
        source: "env",
        origin: "BITBUCKET_TOKEN",
        active: true,
        state: "unchecked",
        note: "Bitbucket's /user endpoint refuses access tokens, so BITBUCKET_TOKEN is never sent anywhere to check",
      },
      {
        service: "bitbucket",
        host: "bitbucket.org",
        source: "env",
        origin: "BITBUCKET_API_TOKEN",
        active: false,
        state: "valid",
        account: "oritwoen",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://api.bitbucket.org/2.0/user"]);
    expect(authorization(fetch)).toBe(
      `Basic ${Buffer.from("ori@example.com:ATATT-api").toString("base64")}`,
    );
  });

  it("shows the email as the account before anything is checked", async () => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    vi.stubEnv("BITBUCKET_EMAIL", "ori@example.com");

    expect(await list()).toMatchObject([
      {
        origin: "BITBUCKET_API_TOKEN",
        active: true,
        state: "unchecked",
        account: "ori@example.com",
      },
    ]);
  });

  it("encodes the basic auth login as UTF-8, as Bitbucket reads it", async () => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    vi.stubEnv("BITBUCKET_EMAIL", "żółw@example.com");
    const fetch = stubFetch(() => Response.json({ username: "zolw" }));

    await list({ verify: true });
    expect(authorization(fetch)).toBe("Basic xbzDs8WCd0BleGFtcGxlLmNvbTpBVEFUVC1hcGk=");
  });

  it("lists an API token without its email as unusable and sends it nowhere", async () => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    const fetch = stubFetch(() => Response.json({ username: "oritwoen" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "bitbucket",
        host: "bitbucket.org",
        source: "env",
        origin: "BITBUCKET_API_TOKEN",
        active: false,
        state: "unchecked",
        note: "BITBUCKET_API_TOKEN goes out with BITBUCKET_EMAIL, which isn't set, so resolve skips it",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a 401 as a rejected token, and a 403 as a scope that hides the user", async () => {
    vi.stubEnv("BITBUCKET_API_TOKEN", "ATATT-api");
    vi.stubEnv("BITBUCKET_EMAIL", "ori@example.com");
    stubFetch(() => Response.json({ type: "error" }, { status: 401 }));
    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);

    stubFetch(() => Response.json({ type: "error" }, { status: 403 }));
    expect(await list({ verify: true })).toMatchObject([
      { state: "unreachable", note: "HTTP 403" },
    ]);
  });
});
