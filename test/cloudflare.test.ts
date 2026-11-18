import { execFile } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

interface CfState {
  whoami: Record<string, unknown>;
  token?: string;
  expiresAt?: string;
  /* Seal the file the way cf does with `keyring_enabled`, under this key. */
  sealedWith?: Buffer;
}

const credentialsFile = join(mkdtempSync(join(tmpdir(), "cf-oauth-")), "default.json");
const KEY = Buffer.alloc(32, 7);
const realPlatform = process.platform;
let cf: CfState;
let cfEnv: NodeJS.ProcessEnv[];
/* What the keyring tool prints, or null when it exits 1 for no such item. */
let keyring: string | null;
let keyringCalls: string[][];

/* Write cf's credentials file: plain JSON, or the AES-256-GCM envelope of cf 1.0.0-rc.1. */
function writeCredentials(): void {
  const plain = JSON.stringify({
    oauth_token: cf.token,
    expiration_time: cf.expiresAt,
    scopes: [],
  });
  if (cf.sealedWith === undefined) {
    writeFileSync(credentialsFile, plain);
    return;
  }
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", cf.sealedWith, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      v: 1,
      alg: "AES-256-GCM",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }),
  );
}

/* Answer the keyring lookup, and fail the test on any other command. */
function answerKeyring(
  command: string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  expect(command[0]).not.toBe("cf");
  keyringCalls.push(command);
  queueMicrotask(() =>
    keyring === null ? callback(new Error("exit 1"), "", "") : callback(null, `${keyring}\n`, ""),
  );
}

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

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
    if (file !== "cf") {
      answerKeyring([file, ...argv], callback);
      return;
    }
    expect(argv).toEqual(["auth", "whoami"]);
    cfEnv.push(options.env);
    writeCredentials();
    queueMicrotask(() => callback(null, JSON.stringify(cf.whoami), ""));
  }) as unknown as typeof execFile);
}

/* Hold each `cf auth whoami` until the test answers it. */
function holdCf(): { answer: () => void; signals: unknown[] } {
  const answers: (() => void)[] = [];
  const signals: unknown[] = [];
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const [, , options, callback] = args as [
      string,
      string[],
      { signal?: AbortSignal },
      (error: Error | null, stdout: string, stderr: string) => void,
    ];
    signals.push(options.signal);
    answers.push(() => {
      writeCredentials();
      callback(null, JSON.stringify(cf.whoami), "");
    });
  }) as unknown as typeof execFile);
  return { answer: () => answers.at(-1)?.(), signals };
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
  keyring = JSON.stringify({ v: 1, key: KEY.toString("base64"), created: "2026-09-01T00:00:00Z" });
  keyringCalls = [];
  stubCf();
  vi.useFakeTimers({ now: new Date("2026-09-30T08:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  onPlatform(realPlatform);
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

  it("refuses an aborted signal before asking cf", async () => {
    const { resolve } = await load();

    await expect(resolve({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("lets one caller stop waiting while cf keeps running for the other", async () => {
    const cfRun = holdCf();
    const { resolve } = await load();
    const controller = new AbortController();

    const leaving = resolve({ signal: controller.signal });
    const staying = resolve();
    controller.abort(new Error("request cancelled"));

    await expect(leaving).rejects.toThrow("request cancelled");
    cfRun.answer();
    await expect(staying).resolves.toMatchObject({ token: "oauth-1" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("never stops cf while it refreshes, and hands its answer to whoever asks next", async () => {
    const cfRun = holdCf();
    const { resolve } = await load();
    const controller = new AbortController();

    const leaving = resolve({ signal: controller.signal });
    controller.abort();
    await expect(leaving).rejects.toMatchObject({ name: "AbortError" });

    const next = resolve();
    cfRun.answer();
    await expect(next).resolves.toMatchObject({ token: "oauth-1" });
    expect(cfRun.signals).toEqual([undefined]);
    await expect(resolve()).resolves.toMatchObject({ token: "oauth-1" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("gives a caller with a signal the same error when cf fails", async () => {
    cf.whoami = { authenticated: false, error: "Not logged in" };
    const { resolve } = await load();

    const error = await resolve({ signal: new AbortController().signal }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ name: "CredentialsError", code: "token" });
    expect(messages(error)).toContain("cf CLI is not logged in");
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

  it("opens the session cf sealed with a key from secret-tool", async () => {
    onPlatform("linux");
    cf.sealedWith = KEY;
    const { resolve } = await load();

    await expect(resolve()).resolves.toEqual({
      token: "oauth-1",
      accountId: "acct-1",
      source: "cli",
      expiresAt: Date.parse("2026-09-30T09:00:00.000Z"),
    });
    expect(keyringCalls).toEqual([
      ["secret-tool", "lookup", "service", "cloudflare", "account", "default"],
    ]);
  });

  it("asks the macOS Keychain for the same key", async () => {
    onPlatform("darwin");
    cf.sealedWith = KEY;
    const { resolve } = await load();

    await expect(resolve()).resolves.toMatchObject({ token: "oauth-1" });
    expect(keyringCalls).toEqual([
      ["/usr/bin/security", "find-generic-password", "-s", "cloudflare", "-a", "default", "-w"],
    ]);
  });

  it("stops recommending a plain cf auth login when the keyring keeps the key", async () => {
    onPlatform("linux");
    cf.sealedWith = KEY;
    keyring = null;
    const { resolve } = await load();

    await expect(resolve()).rejects.toMatchObject({
      code: "token",
      message:
        "The cf OAuth credentials file is encrypted, and its key could not be read from the OS keyring. Set CLOUDFLARE_API_TOKEN, or run `cf auth login --no-use-keyring` to keep the session in a file this package can read",
    });
  });

  it("never runs a keyring tool where cf uses a native binding", async () => {
    onPlatform("win32");
    cf.sealedWith = KEY;
    const { resolve } = await load();

    await expect(resolve()).rejects.toThrow("could not be read from the OS keyring");
    expect(keyringCalls).toEqual([]);
  });

  it("blames the format, not the login, for an envelope cf has since changed", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string) => void;
      writeFileSync(credentialsFile, JSON.stringify({ v: 2, alg: "X", ciphertext: "AAAA" }));
      queueMicrotask(() => callback(null, JSON.stringify(loggedIn(["acct-1"]))));
    }) as unknown as typeof execFile);
    const { resolve } = await load();

    await expect(resolve()).rejects.toThrow(
      "encrypted in a way this package cannot read. Set CLOUDFLARE_API_TOKEN, or run `cf auth login --no-use-keyring`",
    );
  });

  it("refuses a key that does not open the file, without quoting either", async () => {
    onPlatform("linux");
    cf.sealedWith = Buffer.alloc(32, 9);
    const { resolve } = await load();

    const error = await resolve().catch((failure: unknown) => failure);
    expect(messages(error)).toContain(
      "The key in the OS keyring does not open the cf OAuth credentials file",
    );
    expect(messages(error)).not.toContain(KEY.toString("base64"));
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

  it("lists a sealed session it can open like any other", async () => {
    onPlatform("linux");
    cf.sealedWith = KEY;
    cf.whoami = sessionStatus(["acct-1"]);
    const { list } = await load();

    expect(await list()).toMatchObject([{ origin: "cf", active: true, state: "valid" }]);
  });

  it("won't call a session valid when the keyring keeps its token", async () => {
    onPlatform("linux");
    cf.sealedWith = KEY;
    keyring = null;
    cf.whoami = sessionStatus(["acct-1"]);
    const { list } = await load();

    const [entry] = await list();
    expect(entry).toMatchObject({
      origin: "cf",
      active: false,
      state: "unchecked",
      account: "dev@example.com",
      note: "resolve cannot use this session. The cf OAuth credentials file is encrypted, and its key could not be read from the OS keyring",
    });
  });

  it("keeps a cf login that isn't OAuth out of resolve's way", async () => {
    cf.whoami = { ...sessionStatus(["acct-1"]), authSource: "Global API key" };
    const { list } = await load();

    expect(await list()).toMatchObject([
      {
        active: false,
        state: "unchecked",
        note: "resolve cannot use this session. cf CLI reports no OAuth session",
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
