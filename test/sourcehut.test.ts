import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseScfg } from "../src/core/hut.ts";
import { resolve } from "../src/sourcehut.ts";

let config: string;

/* Write hut's config under the isolated XDG dir; hut itself is not on PATH. */
function writeHutConfig(content: string): void {
  mkdirSync(join(config, "hut"), { recursive: true });
  writeFileSync(join(config, "hut", "config"), content);
}

/* An access-token-cmd that runs this Node and prints the given lines, written without backslashes, which scfg would eat. */
function printing(...lines: string[]): string {
  return `access-token-cmd "${process.execPath}" -p '${JSON.stringify(lines)}.join(String.fromCharCode(10))'`;
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "credentials-hut-"));
  vi.stubEnv("XDG_CONFIG_HOME", config);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sourcehut.resolve", () => {
  it("takes the explicit token, then SRHT_TOKEN, before hut's file", () => {
    writeHutConfig('instance "sr.ht" {\n  origin "sr.ht"\n  access-token "from-file"\n}\n');
    vi.stubEnv("SRHT_TOKEN", "from-env");

    expect(resolve({ token: "mine" })).toEqual({ token: "mine", source: "explicit" });
    expect(resolve()).toEqual({ token: "from-env", source: "env" });
  });

  it("reads the sr.ht instance for sr.ht and for any of its services", () => {
    writeHutConfig('instance "sourcehut" {\n  origin "sr.ht"\n  access-token "srht-file"\n}\n');

    expect(resolve()).toEqual({ token: "srht-file", source: "config" });
    expect(resolve({ baseURL: "https://git.sr.ht/~me/repo" })).toEqual({
      token: "srht-file",
      source: "config",
    });
  });

  it("picks the instance of the host asked about, the first one when two match", () => {
    writeHutConfig(
      [
        'instance "sr.ht" {',
        '  origin "sr.ht"',
        '  access-token "public"',
        "}",
        'instance "home" {',
        '  origin "srht.home.example"',
        '  access-token "home-1"',
        "}",
        'instance "home-again" {',
        '  origin "srht.home.example"',
        '  access-token "home-2"',
        "}",
      ].join("\n"),
    );

    expect(resolve({ baseURL: "https://todo.srht.home.example" })?.token).toBe("home-1");
    expect(resolve({ baseURL: "https://git.other.example" })).toBeNull();
  });

  it("falls back to the instance name without origin, as hut 0.9 does", () => {
    writeHutConfig('instance "sr.ht" {\n  access-token "named"\n}\n');

    expect(resolve()?.token).toBe("named");
  });

  it("matches a host set for one service, such as a meta on its own domain", () => {
    writeHutConfig(
      [
        'instance "corp" {',
        '  origin "srht.corp.example"',
        '  access-token "corp"',
        "  git {",
        '    origin "https://code.corp.example:8443"',
        "  }",
        "}",
      ].join("\n"),
    );

    expect(resolve({ baseURL: "https://code.corp.example" })?.token).toBe("corp");
  });

  it("reads hut's file where Go puts it on macOS, not under XDG", () => {
    const home = mkdtempSync(join(tmpdir(), "credentials-home-"));
    const file = join(home, "Library", "Application Support", "hut", "config");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, 'instance "sr.ht" {\n  origin "sr.ht"\n  access-token "mac"\n}\n');
    writeHutConfig('instance "sr.ht" {\n  origin "sr.ht"\n  access-token "xdg"\n}\n');
    vi.stubEnv("HOME", home);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try {
      expect(resolve()?.token).toBe("mac");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("never hands an instance's token to its parent domain, which hut would still match", () => {
    writeHutConfig('instance "corp" {\n  origin "srht.corp.example"\n  access-token "corp"\n}\n');

    expect(resolve({ baseURL: "https://corp.example" })).toBeNull();
  });

  it("runs access-token-cmd and keeps the first word it prints, like hut", () => {
    writeHutConfig(
      `instance "sr.ht" {\n  origin "sr.ht"\n  ${printing("", "  from-pass  extra", "url: x")}\n}\n`,
    );

    expect(resolve()).toEqual({ token: "from-pass", source: "config" });
  });

  it("finds nothing when access-token-cmd fails or prints nothing", () => {
    writeHutConfig(
      'instance "sr.ht" {\n  origin "sr.ht"\n  access-token-cmd /nonexistent/pass\n}\n',
    );
    expect(resolve()).toBeNull();

    writeHutConfig(`instance "sr.ht" {\n  origin "sr.ht"\n  ${printing("")}\n}\n`);
    expect(resolve()).toBeNull();
  });

  it("finds nothing without the file, and nothing for a named account past the env", () => {
    expect(resolve()).toBeNull();

    writeHutConfig('instance "sr.ht" {\n  origin "sr.ht"\n  access-token "x"\n}\n');
    expect(resolve({ account: "~me" })).toBeNull();
  });
});

describe("parseScfg", () => {
  it("unquotes, unescapes and nests the way go-scfg reads them", () => {
    const parsed = parseScfg(
      [
        "# a comment line",
        'instance "my instance" {',
        "  access-token 'single \\ kept'",
        '  origin "with \\"quote\\""',
        "  bare\\ word two",
        "  meta {",
        '    origin "https://meta.example"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      {
        name: "instance",
        params: ["my instance"],
        children: [
          { name: "access-token", params: ["single  kept"], children: [] },
          { name: "origin", params: ['with "quote"'], children: [] },
          { name: "bare word", params: ["two"], children: [] },
          {
            name: "meta",
            params: [],
            children: [{ name: "origin", params: ["https://meta.example"], children: [] }],
          },
        ],
      },
    ]);
  });

  it("ignores a stray closing brace instead of losing the rest of the file", () => {
    expect(parseScfg("}\na 1\n")).toEqual([{ name: "a", params: ["1"], children: [] }]);
  });
});
