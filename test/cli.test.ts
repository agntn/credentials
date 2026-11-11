import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };

const switches = new Set([
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_DISABLE_COLORS",
  "CREDENTIALS_DIST",
  "TEST",
]);
/** Token variables a developer machine may export; the tests run without any of them. */
const tokens = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GL_TOKEN",
  "GITLAB_PAT",
  "GITLAB_HOST",
  "GITEA_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "AGNTN_CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
  "GH_CONFIG_DIR",
]);
/** No gh, glab or cf on PATH and empty config dirs, so only the variables a test sets are found. */
const isolated = mkdtempSync(join(tmpdir(), "credentials-home-"));
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !switches.has(key) && !tokens.has(key)),
  ),
  TERM: "xterm-256color",
  PATH: isolated,
  XDG_CONFIG_HOME: isolated,
};

function run(...args: readonly string[]) {
  return runWith({}, ...args);
}

function runWith(extra: Readonly<Record<string, string>>, ...args: readonly string[]) {
  const { status, stderr, stdout } = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...env, ...extra },
  });
  return { code: status, stderr, stdout };
}

describe("credentials CLI", () => {
  it("prints the usage and its errors without colors into a pipe", () => {
    const help = run("--help");
    const usage = run("list", "--help");
    const unknown = run("nope");

    expect(help.stdout).toContain("USAGE credentials <command> [OPTIONS]");
    expect(help.stdout).toMatch(/^ {2}list {2}Credentials on this machine, without the tokens/m);
    expect(usage.stdout).toContain("SERVICE");
    expect(usage.stdout).toContain("--[no-]verify");
    expect(unknown).toMatchObject({
      code: 1,
      stderr: 'Unknown command "nope"\nRun credentials --help for the commands\n',
    });
    for (const output of [help, usage, unknown]) {
      expect(output.stdout + output.stderr).not.toContain("\u001B");
    }
  });

  it("lists the credentials it finds and never prints a token", () => {
    const listed = runWith({ GH_TOKEN: "gho_cli_secret" }, "list", "github");
    const json = runWith({ GH_TOKEN: "gho_cli_secret" }, "list", "github", "--json");

    expect(listed).toMatchObject({ code: 0, stderr: "" });
    expect(listed.stdout).toContain(
      "  * github.com | unknown account | GH_TOKEN (env) | unchecked",
    );
    expect(JSON.parse(json.stdout)).toMatchObject({
      services: ["github"],
      verified: false,
      credentials: [{ origin: "GH_TOKEN", source: "env", active: true, state: "unchecked" }],
    });
    expect(listed.stdout + json.stdout).not.toContain("gho_cli_secret");
    expect(run("list")).toMatchObject({ code: 0 });
    expect(run("list").stdout).toContain(
      "cloudflare: nothing found (set CLOUDFLARE_API_TOKEN or run cf auth login)",
    );
    expect(run("list", "nope")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Invalid arguments at [SERVICE]: must be one of github, gitlab, gitea, cloudflare\n",
    });
  });

  it("refuses an option the command doesn't take in one line", () => {
    expect(run("-_8")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: 'Unknown command "-_8"\nRun credentials --help for the commands\n',
    });
    const listTakes = "takes --verify, --json";
    expect(run("list", "--nmae", "x")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: `Invalid arguments: unknown option "--nmae"; ${listTakes}\n`,
    });
    // A dash word lands in the positional SERVICE, where the enum refuses it.
    expect(run("list", "--version")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Invalid arguments at [SERVICE]: must be one of github, gitlab, gitea, cloudflare\n",
    });
    expect(run("mcp", "--stdio")).toMatchObject({
      code: 1,
      stdout: "",
      stderr: 'Invalid arguments: unknown option "--stdio"; takes no options\n',
    });
    expect(run("--version")).toMatchObject({ code: 0, stdout: `${pkg.version}\n` });
    expect(run("list", "--", "-_8")).toMatchObject({ code: 1 });
  });
});

const root = fileURLToPath(new URL("..", import.meta.url));

/* Writes the module URLs the child loaded to `file` on exit; stderr cuts them at about 146 KB. */
function recordLoads(file: string) {
  return `data:text/javascript,${encodeURIComponent(`
  import { writeFileSync } from "node:fs";
  import { registerHooks } from "node:module";
  const loaded = [];
  registerHooks({
    load(url, context, nextLoad) {
      loaded.push(url);
      return nextLoad(url, context);
    },
  });
  process.on("exit", () => writeFileSync(${JSON.stringify(file)}, JSON.stringify(loaded)));
`)}`;
}

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "credentials-test", version: "1.0.0" },
  },
})}\n`;

/**
 * Runs `mcp` from a built bin, answers one initialize request and tells where the server came
 * from. stdin closes after the request, so the server exits on its own.
 * @param base - Package root the bin sits in.
 * @param extraEnv - Environment on top of the shared one.
 * @returns {{ code: number | null, from: string, name: string | undefined, stderr: string }} The
 * exit code, where the server came from, the server name from the reply and stderr.
 */
function serve(base: string, extraEnv: Readonly<Record<string, string>> = {}) {
  const record = mkdtempSync(join(tmpdir(), "credentials-loaded-"));
  const file = join(record, "loaded.json");
  let child;
  let loaded: unknown = [];
  try {
    child = spawnSync(
      process.execPath,
      ["--import", recordLoads(file), join(base, "dist/cli.mjs"), "mcp"],
      { encoding: "utf8", env: { ...env, ...extraEnv }, input: initialize, timeout: 20_000 },
    );
    if (existsSync(file)) loaded = JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(record, { recursive: true, force: true });
  }
  const { status, stderr, stdout } = child;
  const urls = Array.isArray(loaded) ? loaded.filter((url) => typeof url === "string") : [];
  const source = urls.includes(pathToFileURL(join(base, "src/mcp.ts")).href);
  const bundle = urls.some((url) => url.endsWith("/node_modules/@agntn/tools/dist/mcp.mjs"));
  let from: "bundle" | "source" | "unknown" = "unknown";
  if (source) from = "source";
  else if (bundle) from = "bundle";
  const name = /"serverInfo":\{"name":"([^"]+)"/.exec(stdout)?.[1];
  return { code: status, from, name, stderr };
}

/**
 * A run that answered the initialize request.
 * @param from - Where the server has to come from.
 * @returns {{ code: number, from: string, name: string }} The fields `serve` has to match.
 */
function served(from: "bundle" | "source") {
  return { code: 0, from, name: "credentials" };
}

const refused = {
  isError: true,
  content: [
    { type: "text", text: "src/ changed under this server, restart it to load the new code" },
  ],
};

/**
 * Starts `mcp` from the built bin of a checkout copy and connects a client to it.
 * @param patch - Rewrites `src/tool-operations.ts` before the server starts.
 * @param reuse - A copy made by an earlier call, served again as it stands.
 * @returns {Promise<{ checkout: string, client: Client }>} The copy and the connected client.
 */
async function checkoutServer(patch?: (operations: string) => string, reuse?: string) {
  const checkout = reuse ?? mkdtempSync(join(tmpdir(), "credentials-cli-"));
  if (reuse === undefined) {
    for (const entry of ["dist", "src", "package.json"]) {
      cpSync(join(root, entry), join(checkout, entry), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"), "dir");
  }
  const operations = join(checkout, "src/tool-operations.ts");
  if (patch) writeFileSync(operations, patch(readFileSync(operations, "utf8")));
  const client = new Client({ name: "credentials-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(checkout, "dist/cli.mjs"), "mcp"],
      env,
      stderr: "ignore",
    }),
  );
  return { checkout, client };
}

describe.skipIf(!existsSync(join(root, "dist/cli.mjs")))(
  "credentials mcp from the built bin",
  () => {
    it("serves the live source inside a checkout", () => {
      expect(serve(root)).toMatchObject(served("source"));
    });

    it("keeps the bundle under CREDENTIALS_DIST=1", () => {
      expect(serve(root, { CREDENTIALS_DIST: "1" })).toMatchObject(served("bundle"));
    });

    it("keeps the bundle when the package sits under node_modules", () => {
      // Node refuses to strip types there, so a copy that ships `src` still takes the bundle.
      const cache = join(root, "node_modules/.cache");
      mkdirSync(cache, { recursive: true });
      const nested = mkdtempSync(join(cache, "credentials-cli-"));
      try {
        for (const entry of ["dist", "src", "package.json"]) {
          cpSync(join(root, entry), join(nested, entry), { recursive: true });
        }
        expect(serve(nested)).toMatchObject(served("bundle"));
      } finally {
        rmSync(nested, { recursive: true, force: true });
      }
    });

    it("keeps the bundle in a package that ships no src", () => {
      const packaged = mkdtempSync(join(tmpdir(), "credentials-cli-"));
      try {
        for (const entry of ["dist", "packages", "package.json"]) {
          cpSync(join(root, entry), join(packaged, entry), { recursive: true });
        }
        symlinkSync(join(root, "node_modules"), join(packaged, "node_modules"), "dir");
        expect(serve(packaged)).toMatchObject(served("bundle"));
      } finally {
        rmSync(packaged, { recursive: true, force: true });
      }
    });

    it("refuses a call after a pull instead of mixing old and new modules", async () => {
      const { checkout, client } = await checkoutServer();
      try {
        await client.listTools();
        /** The incident in keys: a loaded module gains an export, a lazy one starts importing it. */
        const contract = join(checkout, "src/tool-contract.ts");
        const operations = join(checkout, "src/tool-operations.ts");
        writeFileSync(contract, `${readFileSync(contract, "utf8")}export const ADDED = 1;\n`);
        writeFileSync(
          operations,
          readFileSync(operations, "utf8").replace(
            "import { SERVICES } from",
            "import { SERVICES, ADDED } from",
          ),
        );

        /** A tool or a schema the pull brought in is news to the old server too. */
        for (const [name, args] of [
          ["credentials_list", {}],
          ["credentials_list", { servic: "github" }],
          ["credentials_added", {}],
        ] as const) {
          expect(await client.callTool({ name, arguments: args })).toMatchObject(refused);
        }
      } finally {
        await client.close();
        rmSync(checkout, { recursive: true, force: true });
      }
    });

    it("blames a pull that lands mid-call for the failure, not the tool", async () => {
      /** The executor writes into `src/` on every call, and the service `gitea` makes it throw. */
      const { checkout, client } = await checkoutServer(
        (operations) =>
          `import { writeFileSync } from "node:fs";\n${operations.replace(
            "  const services = selectedServices(input.service);",
            `  writeFileSync(new URL(\`./pulled-\${String(input.service)}.ts\`, import.meta.url), "export {};\\n");
  if (input.service === "gitea") throw new Error("boom");
  const services = selectedServices(input.service);`,
          )}`,
      );
      try {
        const kept = await client.callTool({
          name: "credentials_list",
          arguments: { service: "github" },
        });
        expect(kept.isError).not.toBe(true);

        const fresh = await checkoutServer(undefined, checkout);
        try {
          expect(
            await fresh.client.callTool({
              name: "credentials_list",
              arguments: { service: "gitea" },
            }),
          ).toMatchObject(refused);
        } finally {
          await fresh.client.close();
        }
      } finally {
        await client.close();
        rmSync(checkout, { recursive: true, force: true });
      }
    });
  },
);
