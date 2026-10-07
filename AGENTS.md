# AGENTS.md

Keep AGENTS.md updated with project status.

## Status

- Owns credential lookup for the family: GitHub, GitLab and Gitea tokens (moved from `@agntn/forges` `src/auth.ts`) and Cloudflare token plus account (moved from `@agntn/memory` `packages/shared/cloudflare-credentials.ts`). A sibling that needs one of these imports the subpath instead of reading env or shelling out to a CLI itself.
- Agent surfaces are informational only (Ori's decision, 2026-10-07): one tool, `credentials_list`, on MCP, Pi, OMP, the AI SDK and as `credentials list` in the CLI, all from `src/tools.ts` through `@agntn/tools`. It reports which credentials exist, where they came from, which one `resolve` uses, their state and expiry. No surface ever returns a token, and no tool takes a host: the model can't send a token anywhere the credential doesn't already point.
- One subpath per service, each exporting `resolve` and `list`. `list` walks every place `resolve` looks and returns `CredentialInfo` records without tokens; the tokens it reads stay inside `src/core/forge-list.ts` and `src/cloudflare.ts`. The root carries only `version`, `CredentialsError` and the types. `export * as github` in the root made rolldown export the internal `github_exports` namespace object from `dist/github.mjs`, so the services stay out of the root.
- Forge chain: explicit `token` (an empty string means anonymous) → env (an empty variable still ends the chain) → CLI (`gh auth token`, `glab config get token`, nothing for tea) → config file (`gh/hosts.yml`, `glab-cli/config.yml`, `tea/config.yml`). Synchronous, returns `null` when nothing is found, as forges always did. A named `account` is honored only by `gh`; on GitLab and Gitea it finds nothing past the environment.
- Cloudflare chain: explicit `token` → `CLOUDFLARE_API_TOKEN` → `cf auth whoami` OAuth session, whose credentials file it reads. Account: explicit `accountId` → `AGNTN_CLOUDFLARE_ACCOUNT_ID` → `CLOUDFLARE_ACCOUNT_ID` → the cf session's account when it reaches exactly one (Ori's decision, 2026-10-07). Empty values count as unset. Asynchronous, throws `CredentialsError` with a setup hint.
- The cf session is cached at module level until a minute before its expiry, one `cf` run serves concurrent callers, and a failed attempt is not cached. `refresh: true` bypasses the cache for a caller that just got a 401. A session without an expiry is read again on every call.
- `cf auth whoami` runs without `CLOUDFLARE_API_TOKEN` in its env, or cf would report the env token instead of its OAuth session. Checked against cf 1.0.0-beta.5.
- `list({ verify: true })` asks each service about its credential: GitHub `/user` (login, `x-oauth-scopes`, `github-authentication-token-expiration`), GitLab `/api/v4/user`, Gitea `/api/v1/user` with the `token` scheme, Cloudflare `/user/tokens/verify` then `/accounts/<id>/tokens/verify` for an account-owned token. A token goes only to its own host: `GH_TOKEN`/`GITHUB_TOKEN` to github.com, `GITLAB_TOKEN` to `GITLAB_HOST` or gitlab.com, CLI logins to the host they were made on. `GITEA_TOKEN` names no host and is never sent. Requests use `redirect: "error"`, read only named fields, and a failure reports `timed out` or `request failed`, never the error text. Cloudflare answers a malformed token with 400, which counts as rejected. The cf session's state comes from `cf auth whoami` (`tokenValid`, `expiresAt`) whether or not `verify` is on, since running cf already reaches the network.
- In-process tests start from `test/setup.ts`: no token variables, an empty `PATH` (no gh, glab or cf) and an empty `XDG_CONFIG_HOME`, set directly so `vi.unstubAllEnvs()` returns there. `test/cli.test.ts` gives its child processes the same isolation.
- `runCli` from `@agntn/tools` 0.2.1 puts a dash word such as `--version` after `list` into the positional `SERVICE`, where the enum refuses it; `test/cli.test.ts` pins that.
- The CLI, MCP server with its restart guard, extensions and their tests come from `_template` (`c8d23cd`).
- No error message quotes a token, a credentials file or CLI output; `JSON.parse` failures never become a `cause`, since a `SyntaxError` quotes its input.

## Stack

- **Runtime**: Node.js >= 26 (`node:child_process`, `node:fs`)
- **Language**: TypeScript (strict)
- **Toolchain**: Vite+ (`vp`), one `vite.config.ts` for test, lint and fmt
- **Build**: obuild from `build.config.ts`, one bundle for the root, four service subpaths, `cli`, `ai`, `mcp` and `tools`
- **Test**: `vp test` (bundled Vitest, API from `vite-plus/test`)
- **Lint**: `vp lint` + `vp fmt` (Oxlint + Oxfmt) through `@agntn/ox`
- **Typecheck**: tsc (native TypeScript 7)
- **Release**: changelogen, npm through GitHub Actions OIDC trusted publishing
- **Package manager**: pnpm

## Scripts

- `pnpm build` - production build
- `pnpm test` - run tests once
- `pnpm lint` - build, lint, format check
- `pnpm fmt` - auto-fix lint + format
- `pnpm typecheck` - type checking of `src/` and `test/`
- `pnpm release` - build, test against that build, and release, in CI's order

## Structure

```
src/index.ts       - version, CredentialsError, types
src/github.ts      - GitHub resolve
src/gitlab.ts      - GitLab resolve
src/gitea.ts       - Gitea resolve
src/cloudflare.ts  - Cloudflare resolve and the cf session cache
src/core/forge.ts  - the chain the three forges share, CLI calls and config readers
src/core/forge-list.ts - every forge credential for `list`, and its verification
src/core/verify.ts - one authenticated GET, classified
src/core/fields.ts - compact and epoch helpers for records
src/core/errors.ts - CredentialsError
src/tools.ts       - the credentials_list definition
src/tool-operations.ts - its executor and text formatting
src/cli.ts, src/mcp.ts, src/ai.ts - surfaces over src/tools.ts
packages/{pi,omp}/extensions/credentials.ts - host extensions
test/              - tests; see test/setup.ts for the isolation
```

## Conventions

- ESM only (`"type": "module"`)
- Exports use `.d.mts` / `.mjs` extensions
- Strict TypeScript (all strict checks enabled)
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- A new service gets its own subpath with `resolve` and `list`, an entry in `build.config.ts` and `exports`, a lister in `src/tool-operations.ts`, the name in `SERVICES`, and a row in the README table.
- Local MCP from source: a bare `credentials mcp` inside a checkout serves `src/mcp.ts` with the restart guard unless `CREDENTIALS_DIST=1`, as in `_template`.
- Pull requests and issues use short, freeform descriptions focused on why a change is needed or what went wrong.
