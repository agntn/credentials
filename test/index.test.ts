import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import * as root from "../src/index.ts";
import * as azureDevOps from "../src/azure-devops.ts";
import * as bitbucket from "../src/bitbucket.ts";
import * as cloudflare from "../src/cloudflare.ts";
import * as cursorOrigin from "../src/cursor-origin.ts";
import * as gitcafe from "../src/gitcafe.ts";
import * as gitea from "../src/gitea.ts";
import * as gitee from "../src/gitee.ts";
import * as github from "../src/github.ts";
import * as gitlab from "../src/gitlab.ts";
import * as pushin from "../src/pushin.ts";
import * as sourcehut from "../src/sourcehut.ts";
import * as tangled from "../src/tangled.ts";
import { SERVICES } from "../src/core/types.ts";

describe("@agntn/credentials", () => {
  it("exports the version from package.json", () => {
    expect(root.version).toBe(pkg.version);
  });

  it("keeps the services out of the root", () => {
    expect(Object.keys(root).sort()).toEqual(["CredentialsError", "version"]);
  });

  it("gives every service subpath resolve and list", () => {
    for (const service of [
      azureDevOps,
      bitbucket,
      cloudflare,
      cursorOrigin,
      gitcafe,
      gitea,
      gitee,
      github,
      gitlab,
      pushin,
      sourcehut,
      tangled,
    ]) {
      expect(Object.keys(service).sort()).toEqual(["list", "resolve"]);
    }
  });

  it("builds, exports and documents a subpath for every service", () => {
    const build = readFileSync(new URL("../build.config.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const service of SERVICES) {
      expect(build).toContain(`"./src/${service}.ts"`);
      expect(Object.keys(pkg.exports)).toContain(`./${service}`);
      expect(readme).toContain(`| \`@agntn/credentials/${service}\``);
    }
  });
});
