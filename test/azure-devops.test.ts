import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/azure-devops.ts";

/* Stub fetch with one answer and keep every call. */
function stubFetch(answer: () => Response): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/* Write an az devops config file and point AZURE_DEVOPS_EXT_CONFIG_DIR at it. */
function azConfig(content: string, variable = "AZURE_DEVOPS_EXT_CONFIG_DIR"): string {
  const dir = mkdtempSync(join(tmpdir(), "credentials-az-"));
  writeFileSync(join(dir, "config"), content);
  vi.stubEnv(variable, dir);
  return dir;
}

/* Write what az devops login falls back to without a keyring, as configparser writes it. */
function patFile(dir: string, pats: Readonly<Record<string, string>>): void {
  const sections = Object.entries(pats).map(
    ([key, token]) => `[${key}]\npersonal access token = ${token}\n`,
  );
  writeFileSync(join(dir, "personalAccessTokens"), sections.join("\n"));
}

const SAVED = {
  "azdevops-cli:https://dev.azure.com/contoso": "pat-contoso",
  "azdevops-cli:https://fabrikam.visualstudio.com": "pat-fabrikam",
  "azdevops-cli: default": "pat-default",
};

/* What connectionData says about a caller, as Azure DevOps shapes it. */
function connection(user: Readonly<Record<string, unknown>>): Response {
  return Response.json({ authenticatedUser: user, authorizedUser: user, instanceId: "i" });
}

const ANONYMOUS = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  descriptor: "System:PublicAccess;aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  providerDisplayName: "Anonymous",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("azure-devops.resolve", () => {
  it("takes the explicit token, then AZURE_DEVOPS_EXT_PAT, with an empty basic auth login", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat-from-env");

    expect(resolve()).toEqual({
      token: "pat-from-env",
      source: "env",
      origin: "AZURE_DEVOPS_EXT_PAT",
      username: "",
    });
    expect(resolve({ token: "mine" })).toEqual({
      token: "mine",
      source: "explicit",
      origin: "token",
      username: "",
    });
    expect(resolve({ token: "mine", username: "ori" })).toMatchObject({ username: "ori" });
  });

  it("keeps an empty AZURE_DEVOPS_EXT_PAT as anonymous access", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "");

    expect(resolve()).toEqual({
      token: "",
      source: "env",
      origin: "AZURE_DEVOPS_EXT_PAT",
      username: "",
    });
  });

  it("finds nothing without the variable or the file, since the keyring stays out of reach", () => {
    azConfig("[defaults]\norganization = https://dev.azure.com/contoso/\n");

    expect(resolve()).toBeNull();
    expect(resolve({ account: "ori" })).toBeNull();
  });

  it("reads the organization's saved PAT, then the one saved without an organization", () => {
    patFile(azConfig(""), SAVED);

    expect(resolve({ baseURL: "https://dev.azure.com/Contoso/Project/_git/repo" })).toEqual({
      token: "pat-contoso",
      source: "config",
      origin: "az devops personalAccessTokens",
      username: "",
      organization: "https://dev.azure.com/Contoso",
    });
    expect(resolve({ baseURL: "https://fabrikam.visualstudio.com/Project" })?.token).toBe(
      "pat-fabrikam",
    );
    expect(resolve({ baseURL: "https://dev.azure.com/other" })?.token).toBe("pat-default");
    expect(resolve()).toEqual({
      token: "pat-default",
      source: "config",
      origin: "az devops personalAccessTokens",
      username: "",
    });
  });

  it("picks the saved PAT of the az default organization", () => {
    const dir = azConfig("[defaults]\norganization = https://dev.azure.com/contoso/\n");
    patFile(dir, SAVED);

    expect(resolve()).toMatchObject({
      token: "pat-contoso",
      organization: "https://dev.azure.com/contoso",
    });
  });

  it("lets the explicit token and AZURE_DEVOPS_EXT_PAT win over the file", () => {
    patFile(azConfig(""), SAVED);
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat-from-env");

    expect(resolve()?.token).toBe("pat-from-env");
    expect(resolve({ token: "mine" })?.token).toBe("mine");
  });

  it("keeps the file from a named account and from a baseURL outside Azure DevOps", () => {
    patFile(azConfig(""), SAVED);

    expect(resolve({ account: "ori" })).toBeNull();
    expect(resolve({ baseURL: "https://tfs.example.com/DefaultCollection" })).toBeNull();
  });

  it("skips empty tokens and sections az devops never writes", async () => {
    patFile(azConfig(""), {
      "azdevops-cli:https://dev.azure.com/contoso": "",
      "keyring:https://dev.azure.com/contoso": "not-ours",
      "azdevops-cli:http://dev.azure.com/contoso": "plain-http",
      "azdevops-cli:https://evil.example/contoso": "elsewhere",
      "azdevops-cli:https://dev.azure.com/Contoso": "not-lower-case",
      "azdevops-cli: default": "pat-default",
    });
    const fetch = stubFetch(() => connection({ id: "u" }));

    expect(resolve({ baseURL: "https://dev.azure.com/contoso" })?.token).toBe("pat-default");
    expect(await list({ verify: true })).toMatchObject([{ host: "any", state: "unchecked" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the file on Linux only, like the extension", () => {
    patFile(azConfig(""), SAVED);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      expect(resolve()).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("brings baseURL down to its organization and lets it win over the az default", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/default-org/\n");

    expect(resolve()?.organization).toBe("https://dev.azure.com/default-org");
    for (const [baseURL, organization] of [
      ["https://dev.azure.com/contoso", "https://dev.azure.com/contoso"],
      ["https://dev.azure.com/contoso/Project/_git/repo?path=/x", "https://dev.azure.com/contoso"],
      ["https://DEV.azure.com:443/contoso/", "https://dev.azure.com/contoso"],
      ["https://contoso.visualstudio.com/Project", "https://contoso.visualstudio.com"],
    ] as const) {
      expect(resolve({ baseURL })?.organization, baseURL).toBe(organization);
    }
  });

  it.each([
    "http://dev.azure.com/contoso",
    "https://dev.azure.com/",
    "https://dev.azure.com:8443/contoso",
    "https://ori@dev.azure.com/contoso",
    "https://:secret@dev.azure.com/contoso",
    "https://dev.azure.com/con%2Ftoso",
    "https://vs-ssh.visualstudio.com/",
    "https://tfs.example.com/DefaultCollection",
    "not a url",
  ])("gives %s no organization and never falls back to the az default", (baseURL) => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/default-org\n");

    expect(resolve({ baseURL })).toEqual({
      token: "pat",
      source: "env",
      origin: "AZURE_DEVOPS_EXT_PAT",
      username: "",
    });
  });

  it("reads the az devops config the way configparser does", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig(
      [
        "[core]",
        "organization = https://dev.azure.com/wrong-section",
        "",
        "  # organization = https://dev.azure.com/commented",
        "[defaults]",
        "project = Project",
        "; organization = https://dev.azure.com/commented",
        "Organization: https://dev.azure.com/contoso/  ",
        "organization = https://dev.azure.com/second",
      ].join("\r\n"),
    );

    expect(resolve()?.organization).toBe("https://dev.azure.com/contoso");
  });

  it("looks for the config where az devops does, knack's own override first", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    const azDir = mkdtempSync(join(tmpdir(), "credentials-azure-"));
    mkdirSync(join(azDir, "azuredevops"));
    writeFileSync(
      join(azDir, "azuredevops", "config"),
      "[defaults]\norganization = https://dev.azure.com/under-az\n",
    );
    vi.stubEnv("AZURE_CONFIG_DIR", azDir);

    expect(resolve()?.organization).toBe("https://dev.azure.com/under-az");
    azConfig("[defaults]\norganization = https://dev.azure.com/extension-dir\n");
    expect(resolve()?.organization).toBe("https://dev.azure.com/extension-dir");
    azConfig(
      "[defaults]\norganization = https://dev.azure.com/knack-dir\n",
      "AZURE_DEVOPS_EXT__CONFIG_DIR",
    );
    expect(resolve()?.organization).toBe("https://dev.azure.com/knack-dir");
  });

  it("lets knack's variable override the config file, an empty one included", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/from-file\n");
    vi.stubEnv("AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION", "https://contoso.visualstudio.com/");

    expect(resolve()?.organization).toBe("https://contoso.visualstudio.com");
    vi.stubEnv("AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION", "");
    expect(resolve()?.organization).toBeUndefined();
  });
});

describe("azure-devops.list", () => {
  it("lists nothing on a machine without the variable", async () => {
    const fetch = stubFetch(() => connection({ id: "u" }));

    expect(await list({ verify: true })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends a PAT that has no organization to go to", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    const fetch = stubFetch(() => connection({ id: "u" }));

    expect(await list({ verify: true })).toEqual([
      {
        service: "azure-devops",
        host: "any",
        source: "env",
        origin: "AZURE_DEVOPS_EXT_PAT",
        active: true,
        state: "unchecked",
        note: "AZURE_DEVOPS_EXT_PAT has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the default organization's connectionData, as az devops login does", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/contoso/\n");
    const fetch = stubFetch(() =>
      connection({
        id: "8c3f1d2e-0000-4000-8000-000000000000",
        providerDisplayName: "Ori",
        properties: { Account: { $type: "System.String", $value: "ori@example.com" } },
      }),
    );

    expect(await list()).toEqual([
      expect.objectContaining({ host: "https://dev.azure.com/contoso", state: "unchecked" }),
    ]);
    expect(await list({ verify: true })).toEqual([
      {
        service: "azure-devops",
        host: "https://dev.azure.com/contoso",
        source: "env",
        origin: "AZURE_DEVOPS_EXT_PAT",
        active: true,
        state: "valid",
        account: "ori@example.com",
      },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://dev.azure.com/contoso/_apis/connectionData");
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(":pat").toString("base64")}`);
    expect(headers.get("x-tfs-fedauthredirect")).toBe("Suppress");
  });

  it("falls back to the display name when the identity has no Account", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/contoso\n");
    stubFetch(() => connection({ id: "u", providerDisplayName: "Ori", properties: {} }));

    expect(await list({ verify: true })).toMatchObject([{ state: "valid", account: "Ori" }]);
  });

  it("calls a token Azure DevOps let in as anonymous rejected, not valid", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/public-org\n");
    stubFetch(() => connection(ANONYMOUS));

    expect(await list({ verify: true })).toMatchObject([
      {
        state: "rejected",
        note: "Azure DevOps took it for anonymous, so it ignored the token",
      },
    ]);
  });

  it("lists every saved PAT and marks the one resolve takes", async () => {
    const dir = azConfig("[defaults]\norganization = https://dev.azure.com/contoso/\n");
    patFile(dir, SAVED);
    const fetch = stubFetch(() => connection({ id: "u", providerDisplayName: "Ori" }));

    const saved = {
      service: "azure-devops",
      source: "config",
      origin: "az devops personalAccessTokens",
    };
    expect(await list({ verify: true })).toEqual([
      {
        ...saved,
        host: "https://dev.azure.com/contoso",
        active: true,
        state: "valid",
        account: "Ori",
      },
      {
        ...saved,
        host: "https://fabrikam.visualstudio.com",
        active: false,
        state: "valid",
        account: "Ori",
      },
      {
        ...saved,
        host: "https://dev.azure.com/contoso",
        active: false,
        state: "valid",
        account: "Ori",
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://dev.azure.com/contoso/_apis/connectionData",
      "https://fabrikam.visualstudio.com/_apis/connectionData",
      "https://dev.azure.com/contoso/_apis/connectionData",
    ]);
    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(":pat-fabrikam").toString("base64")}`,
    );
  });

  it("puts AZURE_DEVOPS_EXT_PAT ahead of the file and never sends a PAT with nowhere to go", async () => {
    patFile(azConfig(""), { "azdevops-cli: default": "pat-default" });
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    const fetch = stubFetch(() => connection({ id: "u" }));

    expect(await list({ verify: true })).toEqual([
      expect.objectContaining({ origin: "AZURE_DEVOPS_EXT_PAT", active: true }),
      {
        service: "azure-devops",
        host: "any",
        source: "config",
        origin: "az devops personalAccessTokens",
        active: false,
        state: "unchecked",
        note: "this PAT has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls a 401 rejected and an answer without a user unreachable", async () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "pat");
    azConfig("[defaults]\norganization = https://dev.azure.com/contoso\n");
    stubFetch(() => Response.json({ message: "TF400813" }, { status: 401 }));
    expect(await list({ verify: true })).toMatchObject([{ state: "rejected", note: "HTTP 401" }]);

    stubFetch(() => Response.json({ instanceId: "i" }));
    expect(await list({ verify: true })).toMatchObject([
      { state: "unreachable", note: "Azure DevOps named no user" },
    ]);
  });
});
