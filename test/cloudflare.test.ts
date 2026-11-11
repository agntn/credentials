import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

interface CfState {
  whoami: Record<string, unknown>;
  token?: string;
  expiresAt?: string;
}

const credentialsFile = join(mkdtempSync(join(tmpdir(), "cf-oauth-")), "default.json");
let cf: CfState;
let cfEnv: NodeJS.ProcessEnv[];

/* Answer `cf auth whoami` the way cf 1.0.0-beta.5 does for an OAuth login. */
function stubCf(): void {
  cfEnv = [];
  vi.mocked(execFile).mockClear();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const [file, argv, options, callback] = args as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
      (error: Error | null, stdout: string, stderr: string) => void,
    ];
    expect([file, ...argv]).toEqual(["cf", "auth", "whoami"]);
    cfEnv.push(options.env);
    writeFileSync(
      credentialsFile,
      JSON.stringify({ oauth_token: cf.token, expiration_time: cf.expiresAt, scopes: [] }),
    );
    queueMicrotask(() => callback(null, JSON.stringify(cf.whoami), ""));
  }) as unknown as typeof execFile);
}

function loggedIn(accounts: string[]): Record<string, unknown> {
  return {
    authenticated: true,
    authSource: `OAuth token from ${credentialsFile}`,
    tokenValid: true,
    accounts: accounts.map((id) => ({ id, name: id })),
  };
}

/** A fresh module, so no test inherits the cf session another one cached. */
async function load(): Promise<typeof import("../src/cloudflare.ts")> {
  vi.resetModules();
  return import("../src/cloudflare.ts");
}

/** Every message down the cause chain, the way a tool host would print the failure. */
function messages(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    parts.push(current.message);
  }
  return parts.join(": ");
}

beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
  vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", undefined);
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
  cf = {
    whoami: loggedIn(["acct-1"]),
    token: "oauth-1",
    expiresAt: "2026-09-30T09:00:00.000Z",
  };
  stubCf();
  vi.useFakeTimers({ now: new Date("2026-09-30T08:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("cloudflare.resolve", () => {
  it("takes an explicit token and account over everything else", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "env-account");
    const { resolve } = await load();

    await expect(resolve({ token: "mine", accountId: "my-account" })).resolves.toEqual({
      token: "mine",
      accountId: "my-account",
      source: "explicit",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("prefers the env token and never asks cf", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "env-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    const { resolve } = await load();

    await expect(resolve()).resolves.toEqual({
      token: "env-token",
      accountId: "env-account",
      source: "env",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("still needs an account id beside an env token", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    const { resolve } = await load();

    await expect(resolve()).rejects.toMatchObject({
      code: "account",
      message:
        "Set AGNTN_CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_API_TOKEN needs an account",
    });
  });

  it("prefers AGNTN_CLOUDFLARE_ACCOUNT_ID and falls back to CLOUDFLARE_ACCOUNT_ID", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "wrangler-account");
    const { resolve } = await load();

    await expect(resolve()).resolves.toMatchObject({ accountId: "wrangler-account" });

    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "agntn-account");
    await expect(resolve()).resolves.toMatchObject({ accountId: "agntn-account" });
  });

  it("takes CLOUDFLARE_ACCOUNT_ID over the accounts of the cf session", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "wrangler-account");
    cf.whoami = loggedIn(["acct-1", "acct-2"]);
    const { resolve } = await load();

    await expect(resolve()).resolves.toMatchObject({
      token: "oauth-1",
      accountId: "wrangler-account",
      source: "cli",
    });
  });

  it("takes the token, its expiry and the only account from the cf OAuth session", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const { resolve } = await load();

    await expect(resolve()).resolves.toEqual({
      token: "oauth-1",
      accountId: "acct-1",
      source: "cli",
      expiresAt: Date.parse("2026-09-30T09:00:00.000Z"),
    });
    expect(cfEnv[0]).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  });

  it("asks for an account id when the cf session reaches several", async () => {
    cf.whoami = loggedIn(["acct-1", "acct-2"]);
    const { resolve } = await load();

    await expect(resolve()).rejects.toMatchObject({
      code: "account",
      message:
        "Set AGNTN_CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID: the cf OAuth session can reach 2 accounts",
    });

    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "acct-2");
    await expect(resolve()).resolves.toMatchObject({ token: "oauth-1", accountId: "acct-2" });
  });

  it("reuses the cf token until a minute before it expires, then reads the refreshed one", async () => {
    const { resolve } = await load();

    await resolve();
    vi.setSystemTime(new Date("2026-09-30T08:58:59.000Z"));
    await expect(resolve()).resolves.toMatchObject({ token: "oauth-1" });
    expect(execFile).toHaveBeenCalledTimes(1);

    cf.token = "oauth-2";
    cf.expiresAt = "2026-09-30T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-09-30T08:59:00.000Z"));
    await expect(resolve()).resolves.toMatchObject({ token: "oauth-2" });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("asks cf again on refresh even before the token expires", async () => {
    const { resolve } = await load();

    await resolve();
    cf.token = "oauth-2";
    await expect(resolve({ refresh: true })).resolves.toMatchObject({ token: "oauth-2" });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("asks cf on every call when the session records no expiry", async () => {
    delete cf.expiresAt;
    const { resolve } = await load();

    await resolve();
    await resolve();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("runs cf once for concurrent callers", async () => {
    const { resolve } = await load();

    const results = await Promise.all([resolve(), resolve()]);

    expect(results.map((result) => result.token)).toEqual(["oauth-1", "oauth-1"]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("asks cf again after a failed attempt", async () => {
    cf.whoami = { authenticated: false, error: "Not logged in" };
    const { resolve } = await load();

    await expect(resolve()).rejects.toThrow(
      "cf CLI is not logged in. Set CLOUDFLARE_API_TOKEN, or run `cf auth login`",
    );

    cf.whoami = loggedIn(["acct-1"]);
    await expect(resolve()).resolves.toMatchObject({ token: "oauth-1" });
  });

  it("names both ways out when cf is not installed", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() =>
        callback(Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" })),
      );
    }) as unknown as typeof execFile);
    const { resolve } = await load();

    const error = await resolve().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "CredentialsError", service: "cloudflare", code: "token" });
    expect(messages(error)).toContain(
      "cf CLI not found. Set CLOUDFLARE_API_TOKEN, or run `cf auth login`",
    );
  });

  it("refuses a cf session that authenticates with something other than OAuth", async () => {
    cf.whoami = {
      ...loggedIn(["acct-1"]),
      authSource: "CLOUDFLARE_API_TOKEN environment variable",
    };
    const { resolve } = await load();

    const error = await resolve().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "token" });
    expect(messages(error)).toContain("cf CLI reports no OAuth session");
  });

  it("reports a credentials file it cannot parse without quoting it", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string) => void;
      writeFileSync(credentialsFile, "cfk_SECRET encrypted by the keyring");
      queueMicrotask(() => callback(null, JSON.stringify(loggedIn(["acct-1"]))));
    }) as unknown as typeof execFile);
    const { resolve } = await load();

    const error = await resolve().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "token" });
    expect(messages(error)).toContain("Cannot read the cf OAuth credentials file");
    expect(messages(error)).not.toContain("SECRET");
  });
});

describe("cloudflare.list", () => {
  function sessionStatus(accounts: string[]): Record<string, unknown> {
    return {
      ...loggedIn(accounts),
      email: "dev@example.com",
      scopes: ["account:read", "workers:write"],
      expiresAt: "2026-09-30T09:00:00.000Z",
    };
  }

  it("describes the cf session with its login, expiry, scopes and single account", async () => {
    cf.whoami = sessionStatus(["acct-1"]);
    const { list } = await load();

    expect(await list()).toEqual([
      {
        service: "cloudflare",
        host: "api.cloudflare.com",
        source: "cli",
        origin: "cf",
        active: true,
        state: "valid",
        account: "dev@example.com",
        accountId: "acct-1",
        accountIdOrigin: "cf session",
        scopes: ["account:read", "workers:write"],
        expiresAt: Date.parse("2026-09-30T09:00:00.000Z"),
      },
    ]);
  });

  it("says no account is chosen when the session reaches several", async () => {
    cf.whoami = sessionStatus(["acct-1", "acct-2"]);
    const { list } = await load();

    expect(await list()).toMatchObject([
      { note: "the session reaches 2 accounts and none is chosen" },
    ]);
  });

  it("puts the env token first, makes it win and checks it with Cloudflare", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-env-secret");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-9");
    cf.whoami = sessionStatus(["acct-1"]);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return url.includes("/user/")
          ? new Response(JSON.stringify({ success: false }), { status: 401 })
          : new Response(
              JSON.stringify({ result: { status: "active", expires_on: "2026-12-31T00:00:00Z" } }),
            );
      }),
    );
    const { list } = await load();

    const entries = await list({ verify: true });

    expect(entries).toMatchObject([
      {
        origin: "CLOUDFLARE_API_TOKEN",
        active: true,
        state: "valid",
        accountId: "acct-9",
        accountIdOrigin: "CLOUDFLARE_ACCOUNT_ID",
        expiresAt: Date.parse("2026-12-31T00:00:00Z"),
      },
      { origin: "cf", active: false, accountId: "acct-9" },
    ]);
    expect(urls).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "https://api.cloudflare.com/client/v4/accounts/acct-9/tokens/verify",
    ]);
    expect(JSON.stringify(entries)).not.toContain("cf-env-secret");
    vi.unstubAllGlobals();
  });

  it("calls a malformed env token rejected", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "bogus");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    const { list } = await load();

    expect((await list({ verify: true }))[0]).toMatchObject({
      state: "rejected",
      note: "HTTP 400",
    });
    vi.unstubAllGlobals();
  });

  it("lists only the env token when cf is not installed", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-env");
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() =>
        callback(Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" })),
      );
    }) as unknown as typeof execFile);
    const { list } = await load();

    expect(await list()).toMatchObject([
      {
        origin: "CLOUDFLARE_API_TOKEN",
        note: "no account id is set, so resolve refuses this token",
      },
    ]);
  });
});
