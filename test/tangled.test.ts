import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/tangled.ts";

/* What bsky.social answered createSession with for a made-up login. */
const REFUSED = { error: "AuthenticationRequired", message: "Invalid identifier or password" };

/* The fields com.atproto.server.createSession requires in its output. */
const SESSION = {
  accessJwt: "access-jwt",
  refreshJwt: "refresh-jwt",
  handle: "alice.example.com",
  did: "did:plc:alice",
};

/* Stub fetch with one answer per call, in order, and keep every call. */
function stubFetch(
  ...answers: Array<() => Response>
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected request");
    return answer();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* One fetch call as the parts a test reads. */
function sent([url, init]: Parameters<typeof globalThis.fetch>) {
  const { method, body, headers, redirect } = init ?? {};
  return {
    url: url instanceof Request ? url.url : url.toString(),
    method,
    body,
    headers,
    redirect,
  };
}

/* Set the login variables, the PDS too when given. */
function envLogin(pds?: string): void {
  vi.stubEnv("TANGLED_HANDLE", "alice.example.com");
  vi.stubEnv("TANGLED_PASSWORD", "abcd-efgh-ijkl-mnop");
  if (pds !== undefined) vi.stubEnv("TANGLED_PDS_URL", pds);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("tangled.resolve", () => {
  it("finds nothing on an empty machine", () => {
    expect(resolve()).toBeNull();
  });

  it("reads the login from the environment, with the PDS only when one is set", () => {
    envLogin();
    expect(resolve()).toEqual({
      identifier: "alice.example.com",
      password: "abcd-efgh-ijkl-mnop",
      source: "env",
    });

    vi.stubEnv("TANGLED_PDS_URL", "https://pds.example.com");
    expect(resolve()).toMatchObject({ source: "env", pds: "https://pds.example.com" });
  });

  it("lets an explicit pair win, with TANGLED_PDS_URL beside it unless a pds is passed", () => {
    envLogin("https://pds.example.com");
    const explicit = { identifier: "did:plc:bob", password: "pass-word" };

    expect(resolve(explicit)).toEqual({
      ...explicit,
      source: "explicit",
      pds: "https://pds.example.com",
    });
    expect(resolve({ ...explicit, pds: "https://bob.example.net" })).toMatchObject({
      pds: "https://bob.example.net",
    });
  });

  it("finds nothing for half a login, and never fills the other half from the environment", () => {
    vi.stubEnv("TANGLED_PASSWORD", "abcd-efgh-ijkl-mnop");
    expect(resolve()).toBeNull();

    vi.stubEnv("TANGLED_HANDLE", "alice.example.com");
    expect(resolve({ identifier: "did:plc:bob" })).toBeNull();
    expect(resolve({ password: "pass-word" })).toBeNull();
  });

  it("treats empty values as unset", () => {
    envLogin("");
    vi.stubEnv("TANGLED_PASSWORD", "");
    expect(resolve()).toBeNull();

    vi.stubEnv("TANGLED_PASSWORD", "abcd-efgh-ijkl-mnop");
    expect(resolve()).not.toHaveProperty("pds");
  });
});

describe("tangled.list", () => {
  it("lists nothing without TANGLED_PASSWORD", async () => {
    vi.stubEnv("TANGLED_HANDLE", "alice.example.com");
    expect(await list({ verify: true })).toEqual([]);
  });

  it("lists a password without its handle as unused", async () => {
    vi.stubEnv("TANGLED_PASSWORD", "abcd-efgh-ijkl-mnop");
    vi.stubEnv("TANGLED_PDS_URL", "https://pds.example.com");
    const fetch = stubFetch();

    expect(await list({ verify: true })).toEqual([
      {
        service: "tangled",
        host: "pds.example.com",
        source: "env",
        origin: "TANGLED_PASSWORD",
        active: false,
        state: "unchecked",
        note: "TANGLED_PASSWORD goes out with TANGLED_HANDLE, which isn't set, so resolve skips it",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends the password when no PDS is named, or the named one isn't http(s)", async () => {
    envLogin();
    const fetch = stubFetch();

    expect(await list({ verify: true })).toEqual([
      {
        service: "tangled",
        host: "any",
        source: "env",
        origin: "TANGLED_PASSWORD",
        active: true,
        state: "unchecked",
        account: "alice.example.com",
        note: "TANGLED_PDS_URL isn't set, so the PDS comes from the handle and the password is never sent anywhere to check",
      },
    ]);

    vi.stubEnv("TANGLED_PDS_URL", "file:///etc/passwd");
    expect(await list({ verify: true })).toMatchObject([
      {
        host: "any",
        note: "TANGLED_PDS_URL isn't an http(s) URL, so the password is never sent anywhere to check",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays off the network without verify", async () => {
    envLogin("https://pds.example.com");
    const fetch = stubFetch();

    expect(await list()).toMatchObject([{ host: "pds.example.com", state: "unchecked" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs in at the PDS, then deletes the session it opened", async () => {
    envLogin("http://localhost:2583/");
    const fetch = stubFetch(
      () => Response.json({ ...SESSION, handle: "alice.test" }),
      () => new Response(null),
    );

    expect(await list({ verify: true })).toEqual([
      {
        service: "tangled",
        host: "localhost:2583",
        source: "env",
        origin: "TANGLED_PASSWORD",
        active: true,
        state: "valid",
        account: "alice.test",
      },
    ]);

    const [login, logout] = fetch.mock.calls.map(sent);
    expect(login).toMatchObject({
      url: "http://localhost:2583/xrpc/com.atproto.server.createSession",
      method: "POST",
      body: JSON.stringify({ identifier: "alice.example.com", password: "abcd-efgh-ijkl-mnop" }),
      redirect: "error",
    });
    expect(login?.headers).not.toHaveProperty("Authorization");
    expect(logout).toMatchObject({
      url: "http://localhost:2583/xrpc/com.atproto.server.deleteSession",
      method: "POST",
      body: undefined,
      headers: { Authorization: "Bearer refresh-jwt" },
      redirect: "error",
    });
  });

  it("calls a refused login rejected and opens no session to close", async () => {
    envLogin("https://pds.example.com");
    const fetch = stubFetch(() => Response.json(REFUSED, { status: 401 }));

    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer when closing the session fails", async () => {
    envLogin("https://pds.example.com");
    stubFetch(
      () => Response.json(SESSION),
      () => {
        throw new TypeError("fetch failed");
      },
    );

    expect(await list({ verify: true })).toMatchObject([
      { state: "valid", account: "alice.example.com" },
    ]);
  });
});
