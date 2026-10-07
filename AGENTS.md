# AGENTS.md

Keep AGENTS.md updated with project status.

## Status

- Owns credential lookup for the family: GitHub, GitLab and Gitea tokens (moved from `@agntn/forges` `src/auth.ts`) and Cloudflare token plus account (moved from `@agntn/memory` `packages/shared/cloudflare-credentials.ts`). A sibling that needs one of these imports the subpath instead of reading env or shelling out to a CLI itself.
- Library only. No CLI, no MCP server, no agent tools: every result is a secret, and a tool would hand it to the model.
- One subpath per service, each exporting a single `resolve`. The root carries only `version`, `CredentialsError` and the types. `export * as github` in the root made rolldown export the internal `github_exports` namespace object from `dist/github.mjs`, so the services stay out of the root.
- Forge chain: explicit `token` (an empty string means anonymous) → env (an empty variable still ends the chain) → CLI (`gh auth token`, `glab config get token`, nothing for tea) → config file (`gh/hosts.yml`, `glab-cli/config.yml`, `tea/config.yml`). Synchronous, returns `null` when nothing is found, as forges always did. A named `account` is honored only by `gh`; on GitLab and Gitea it finds nothing past the environment.
- Cloudflare chain: explicit `token` → `CLOUDFLARE_API_TOKEN` → `cf auth whoami` OAuth session, whose credentials file it reads. Account: explicit `accountId` → `AGNTN_CLOUDFLARE_ACCOUNT_ID` → `CLOUDFLARE_ACCOUNT_ID` → the cf session's account when it reaches exactly one (Ori's decision, 2026-10-07). Empty values count as unset. Asynchronous, throws `CredentialsError` with a setup hint.
- The cf session is cached at module level until a minute before its expiry, one `cf` run serves concurrent callers, and a failed attempt is not cached. `refresh: true` bypasses the cache for a caller that just got a 401. A session without an expiry is read again on every call.
- `cf auth whoami` runs without `CLOUDFLARE_API_TOKEN` in its env, or cf would report the env token instead of its OAuth session. Checked against cf 1.0.0-beta.5.
- No error message quotes a token, a credentials file or CLI output; `JSON.parse` failures never become a `cause`, since a `SyntaxError` quotes its input.

## Stack

- **Runtime**: Node.js >= 26 (`node:child_process`, `node:fs`)
- **Language**: TypeScript (strict)
- **Toolchain**: Vite+ (`vp`), one `vite.config.ts` for test, lint and fmt
- **Build**: obuild from `build.config.ts`, one bundle for the root and four subpaths
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
src/core/errors.ts - CredentialsError
test/              - tests; `execFile`, `execFileSync` and `readFileSync` are mocked
```

## Conventions

- ESM only (`"type": "module"`)
- Exports use `.d.mts` / `.mjs` extensions
- Strict TypeScript (all strict checks enabled)
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- A new service gets its own subpath with one `resolve`, an entry in `build.config.ts` and `exports`, and a row in the README table.
- Pull requests and issues use short, freeform descriptions focused on why a change is needed or what went wrong.
