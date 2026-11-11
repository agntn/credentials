import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/gitee.ts";

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("gitee.resolve", () => {
  it("takes the explicit token, then GITEE_TOKEN, then GITEE_ACCESS_TOKEN", () => {
    vi.stubEnv("GITEE_ACCESS_TOKEN", "from-mcp-gitee");

    expect(resolve()).toEqual({
      token: "from-mcp-gitee",
      source: "env",
      origin: "GITEE_ACCESS_TOKEN",
    });
    vi.stubEnv("GITEE_TOKEN", "from-env");
    expect(resolve()).toEqual({ token: "from-env", source: "env", origin: "GITEE_TOKEN" });
    expect(resolve({ token: "mine" })).toEqual({
      token: "mine",
      source: "explicit",
      origin: "token",
    });
  });

  it("finds nothing without a variable, since Gitee has no CLI login to read", () => {
    expect(resolve()).toBeNull();
    expect(resolve({ baseURL: "https://gitee.com" })).toBeNull();
  });

  it("keeps an empty GITEE_TOKEN as anonymous access", () => {
    vi.stubEnv("GITEE_TOKEN", "");
    vi.stubEnv("GITEE_ACCESS_TOKEN", "never-reached");

    expect(resolve()).toEqual({ token: "", source: "env", origin: "GITEE_TOKEN" });
  });
});

describe("gitee.list", () => {
  it("lists nothing on a machine without a token variable", async () => {
    const fetch = stubFetch(() => Response.json({}));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks GITEE_TOKEN against gitee.com with the token scheme", async () => {
    vi.stubEnv("GITEE_TOKEN", "gitee-env");
    vi.stubEnv("GITEE_ACCESS_TOKEN", "gitee-mcp");
    const fetch = stubFetch(() => Response.json({ id: 1, login: "ori" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "gitee",
        host: "gitee.com",
        source: "env",
        origin: "GITEE_TOKEN",
        active: true,
        state: "valid",
        account: "ori",
      },
      {
        service: "gitee",
        host: "gitee.com",
        source: "env",
        origin: "GITEE_ACCESS_TOKEN",
        active: false,
        state: "valid",
        account: "ori",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://gitee.com/api/v5/user",
      "https://gitee.com/api/v5/user",
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "token gitee-env",
    );
  });

  it("checks the token where GITEE_API_BASE sends it, not on gitee.com", async () => {
    vi.stubEnv("GITEE_ACCESS_TOKEN", "private-deploy");
    vi.stubEnv("GITEE_API_BASE", "https://git.corp.example/api/v5/");
    const fetch = stubFetch(() => Response.json({ login: "dev" }));

    expect(await list({ verify: true })).toMatchObject([
      { host: "git.corp.example", account: "dev", state: "valid" },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://git.corp.example/api/v5/user"]);
  });

  it.each(["corp gitee", "file:///srv/gitee"])(
    "sends the token nowhere when GITEE_API_BASE %s names no host",
    async (base) => {
      vi.stubEnv("GITEE_TOKEN", "gitee-env");
      vi.stubEnv("GITEE_API_BASE", base);
      const fetch = stubFetch(() => Response.json({ login: "ori" }));

      expect(await list({ verify: true })).toMatchObject([
        {
          host: "any",
          state: "unchecked",
          note: "GITEE_TOKEN names no host, so it is never sent anywhere to check",
        },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reads a 401 from gitee.com as a rejected token", async () => {
    vi.stubEnv("GITEE_TOKEN", "revoked");
    stubFetch(() =>
      Response.json({ message: "401 Unauthorized: Access token does not exist" }, { status: 401 }),
    );

    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);
  });
});
