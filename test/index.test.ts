import { describe, expect, it } from "vite-plus/test";
import * as root from "../src/index.ts";
import * as cloudflare from "../src/cloudflare.ts";
import * as gitea from "../src/gitea.ts";
import * as github from "../src/github.ts";
import * as gitlab from "../src/gitlab.ts";

describe("@agntn/credentials", () => {
  it("exports the version from package.json", () => {
    expect(root.version).toBe("0.0.0");
  });

  it("keeps the services out of the root", () => {
    expect(Object.keys(root).sort()).toEqual(["CredentialsError", "version"]);
  });

  it("gives every service subpath a single resolve", () => {
    for (const service of [cloudflare, gitea, github, gitlab]) {
      expect(Object.keys(service)).toEqual(["resolve"]);
    }
  });
});
