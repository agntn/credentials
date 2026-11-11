import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = fileURLToPath(new URL("..", import.meta.url));

const read = (path: string) => readFileSync(join(root, path), "utf8");

const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

const workflow = read(".github/workflows/release.yml");

/**
 * One job of `release.yml`, from its key to the next job's.
 * @param name - The job's key.
 * @returns {string} Its lines, so a step or `needs` of another job never counts.
 */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`release.yml has no ${name} job`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z]+:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** The tag's test job, whose `credentials mcp` checks start the built bin. */
const testSteps = [...job("test").matchAll(/^\s*- run: (.+)$/gmu)].map((match) => match[1] ?? "");

describe("a release", () => {
  it("builds before the tests on the tag", () => {
    expect(testSteps).toContain("pnpm build");
    expect(testSteps.indexOf("pnpm build")).toBeLessThan(testSteps.indexOf("pnpm test"));
  });

  it("packs only after the tests and publishes only that pack", () => {
    expect(job("pack")).toMatch(/^ {4}needs: test$/mu);
    expect(job("publish")).toMatch(/^ {4}needs: pack$/mu);
  });

  /** uppt only runs `pnpm pack`, so without this the tarball ships no `dist/`. */
  it("builds dist/ when packing", () => {
    expect(manifest.scripts.prepack).toBe("pnpm run build");
  });

  /** A map that pins a throw on a lone `}` is worse than none, so the build makes none. */
  it.skipIf(!existsSync(join(root, "dist")))("ships no source maps", () => {
    const pointers = globSync("dist/**/*.{mjs,d.mts}", { cwd: root }).filter((file) =>
      read(file).includes("sourceMappingURL"),
    );

    expect([...globSync("dist/**/*.map", { cwd: root }), ...pointers]).toEqual([]);
  });
});
