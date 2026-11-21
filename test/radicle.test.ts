import { Buffer } from "node:buffer";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { list, resolve } from "../src/radicle.ts";

/* Homes `rad auth` 1.10.3 wrote from fixed seeds: alice without a passphrase, bob with one. */
const FIXTURES = fileURLToPath(new URL("fixtures/radicle", import.meta.url));
const ALICE = "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S";
const BOB = "did:key:z6MkqGC3nWZhYieEVTVDKW5v588CiGfsDSmRVG9ZwwWTvLSK";

/* The head of an OpenSSH secret key up to its cipher name, all the reader looks at. */
function secretKey(cipher: string): string {
  const field = (text: string) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(text.length);
    return Buffer.concat([length, Buffer.from(text, "latin1")]);
  };
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), field(cipher)]);
  const label = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
  return `-----BEGIN ${label}-----\n${body.toString("base64")}\n-----END ${label}-----\n`;
}

/* A scratch copy of one fixture home with its secret key, so a test can break its files. */
function home(name: "plain" | "enc"): string {
  const path = join(mkdtempSync(join(tmpdir(), "credentials-radicle-")), name);
  cpSync(join(FIXTURES, name), path, { recursive: true });
  writeFileSync(join(path, "keys", "radicle"), secretKey(name === "enc" ? "aes256-ctr" : "none"));
  return path;
}

/* The `~/.radicle` a test planted in the setup's scratch HOME. */
function dotRadicle(): string {
  return join(process.env.HOME ?? "", ".radicle");
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dotRadicle(), { recursive: true, force: true });
});

describe("radicle.resolve", () => {
  it("finds nothing on an empty machine", () => {
    expect(resolve()).toBeNull();
  });

  it("reads the DID rad self --did prints, and the alias, from RAD_HOME", () => {
    const path = home("plain");
    vi.stubEnv("RAD_HOME", path);

    expect(resolve()).toEqual({
      home: path,
      did: ALICE,
      alias: "alice",
      keyPath: join(path, "keys", "radicle"),
      encrypted: false,
      source: "env",
    });
  });

  it("falls back to ~/.radicle, and lets an explicit home win over RAD_HOME", () => {
    const path = home("plain");
    cpSync(path, dotRadicle(), { recursive: true });
    expect(resolve()).toMatchObject({ did: ALICE, source: "config" });

    vi.stubEnv("RAD_HOME", path);
    expect(resolve({ home: home("enc") })).toMatchObject({ did: BOB, source: "explicit" });
  });

  it("hands over RAD_PASSPHRASE only with an encrypted key", () => {
    vi.stubEnv("RAD_PASSPHRASE", "hunter2");
    vi.stubEnv("RAD_HOME", home("enc"));
    expect(resolve()).toMatchObject({ did: BOB, encrypted: true, passphrase: "hunter2" });

    vi.stubEnv("RAD_HOME", home("plain"));
    expect(resolve()).not.toHaveProperty("passphrase");
  });

  it("treats an empty RAD_HOME as an error, not as a reason to read ~/.radicle", () => {
    cpSync(home("plain"), dotRadicle(), { recursive: true });
    vi.stubEnv("RAD_HOME", "");
    expect(resolve()).toBeNull();
  });

  it("finds nothing with a key file missing, broken or of another type", () => {
    const path = home("plain");
    vi.stubEnv("RAD_HOME", path);
    const pub = join(path, "keys", "radicle.pub");

    writeFileSync(pub, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ radicle\n");
    expect(resolve()).toBeNull();
    writeFileSync(pub, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBK radicle\n");
    expect(resolve()).toBeNull();
    writeFileSync(
      pub,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3 radicle\n",
    );
    writeFileSync(join(path, "keys", "radicle"), "not a key\n");
    expect(resolve()).toBeNull();
  });

  it("finds nothing where rad won't load the profile: a broken config.json or alias", () => {
    const path = home("plain");
    vi.stubEnv("RAD_HOME", path);
    const config = join(path, "config.json");

    writeFileSync(config, "{");
    expect(resolve()).toBeNull();
    for (const alias of [undefined, "", "car ol", "carol\nSYSTEM:", "c".repeat(33)]) {
      writeFileSync(config, JSON.stringify({ node: { alias } }));
      expect(resolve()).toBeNull();
    }
    writeFileSync(config, JSON.stringify({ node: { alias: "carol" } }));
    expect(resolve()).toMatchObject({ did: ALICE, alias: "carol" });
  });

  it("finds nothing without a HOME to put .radicle in, as rad does", () => {
    cpSync(home("plain"), dotRadicle(), { recursive: true });
    const scratch = process.env.HOME ?? "";
    try {
      delete process.env.HOME;
      expect(resolve()).toBeNull();
    } finally {
      process.env.HOME = scratch;
    }
    expect(resolve()).toMatchObject({ did: ALICE });
  });
});

describe("radicle.list", () => {
  it("lists nothing on an empty machine", async () => {
    await expect(list()).resolves.toEqual([]);
  });

  it("names the alias and DID, and says the key never leaves the machine", async () => {
    vi.stubEnv("RAD_HOME", home("plain"));

    await expect(list({ verify: true })).resolves.toEqual([
      {
        service: "radicle",
        host: "any",
        source: "env",
        origin: "RAD_HOME",
        active: true,
        state: "unchecked",
        account: "alice",
        note: `${ALICE}, no passphrase. It signs here and never leaves the machine`,
      },
    ]);
  });

  it("says how an encrypted key gets unlocked", async () => {
    vi.stubEnv("RAD_HOME", home("enc"));
    expect((await list())[0]?.note).toBe(
      `${BOB}, encrypted, so rad wants it in ssh-agent. It signs here and never leaves the machine`,
    );

    vi.stubEnv("RAD_PASSPHRASE", "hunter2");
    const [entry] = await list();
    expect(entry?.note).toBe(
      `${BOB}, encrypted, unlocked by RAD_PASSPHRASE. It signs here and never leaves the machine`,
    );
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });

  it("names ~/.radicle as the origin when RAD_HOME is unset", async () => {
    cpSync(home("enc"), dotRadicle(), { recursive: true });
    expect(await list()).toMatchObject([
      { source: "config", origin: "rad keys/radicle", account: "bob" },
    ]);
  });
});
