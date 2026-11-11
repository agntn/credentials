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

    expect(resolve()).toEqual({ token: "pat-from-env", source: "env", username: "" });
    expect(resolve({ token: "mine" })).toEqual({ token: "mine", source: "explicit", username: "" });
    expect(resolve({ token: "mine", username: "ori" })).toMatchObject({ username: "ori" });
  });

  it("keeps an empty AZURE_DEVOPS_EXT_PAT as anonymous access", () => {
    vi.stubEnv("AZURE_DEVOPS_EXT_PAT", "");

    expect(resolve()).toEqual({ token: "", source: "env", username: "" });
  });

  it("finds nothing without the variable, since az devops login keeps the PAT in the keyring", () => {
    azConfig("[defaults]\norganization = https://dev.azure.com/contoso/\n");

    expect(resolve()).toBeNull();
    expect(resolve({ account: "ori" })).toBeNull();
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

    expect(resolve({ baseURL })).toEqual({ token: "pat", source: "env", username: "" });
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
