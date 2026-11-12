# @agntn/credentials

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/credentials)

🔑 Twelve services, one `resolve` and one `list` each. You already logged in with `gh` and `cf`. Your code should notice.

## Why?

Every package that talks to GitHub or Cloudflare ends up with its own token hunt. One reads `GH_TOKEN`. Another shells out to `gh`. A third ignores `cf`, so `cf auth login` works in one package and not the next. This package does the hunt once, the same way everywhere.

## ✨ Features

- 🔗 **One chain, every service.** Explicit value, then env, then the CLI, then its config file.
- 🐙 **GitHub, GitLab, Gitea, Sourcehut, Pushin, Cursor Origin, GitCafe.** `gh`, `glab`, `tea`, `hut`, `pun`, `origin` and `cafe` logins work as they are.
- 👥 **Pick a GitHub account.** Got two `gh` logins? Name one. The active login stays put.
- 🏠 **Self-hosted hosts.** Pass a `baseURL` and the CLI login for that host is used.
- ☁️ **Cloudflare without an API token.** The `cf` OAuth session is enough. It's read again once it expires.
- 🏷️ **Source on every result.** `explicit`, `env`, `cli` or `config`. Handy when the wrong token wins.
- 🔍 **See what's there.** `list` shows every credential, which one wins and whether it still works.
- 📬 **Checks stay home.** `verify` sends a token only to the host it belongs to.
- 🤐 **Quiet errors.** No token, file content or CLI output ever lands in a message.

## 📦 Install

```bash
pnpm add @agntn/credentials
```

## 🚀 First call

```bash
npx @agntn/credentials list --verify
```

```
2 credentials, checked with each service. * marks the one resolve uses for its host. Tokens are never shown.
github
  * github.com | unknown account | GH_TOKEN (env) | rejected | HTTP 401
gitlab: nothing found (set GITLAB_TOKEN or run glab auth login)
gitea
  * any | unknown account | GITEA_TOKEN (env) | unchecked | GITEA_TOKEN names no host without a valid GITEA_INSTANCE_URL, so it is never sent anywhere to check
gitee: nothing found (set GITEE_TOKEN or GITEE_ACCESS_TOKEN)
sourcehut: nothing found (set SRHT_TOKEN or run hut init)
bitbucket: nothing found (set BITBUCKET_TOKEN, or BITBUCKET_API_TOKEN with BITBUCKET_EMAIL)
azure-devops: nothing found (set AZURE_DEVOPS_EXT_PAT)
pushin: nothing found (set PUSHIN_TOKEN or run pun login)
cursor-origin: nothing found (set CURSOR_AUTH_TOKEN or run origin auth login)
gitcafe: nothing found (set CAFE_TOKEN or run cafe auth login)
tangled: nothing found (set TANGLED_HANDLE and TANGLED_PASSWORD, an app password)
cloudflare: nothing found (set CLOUDFLARE_API_TOKEN or run cf auth login)
```

That `GH_TOKEN` is long dead, and GitHub said so. It also wins over any `gh` login. `gh` works and your tool gets 401? Look there first. `GITEA_TOKEN` never left the machine. Nothing tells it which host it's for. Set `GITEA_INSTANCE_URL`, as `tea` wants it, and it gets checked there.

Want plain `credentials` instead of `npx`? `pnpm add -g @agntn/credentials` once.

### Commands

| Command | What it does                                   |
| ------- | ---------------------------------------------- |
| `list`  | Every credential, its source, state and expiry |
| `mcp`   | Run the MCP server over stdio                  |

`list github` narrows it to one service. `--verify` asks the services, `--json` prints the full records.

## 🧠 Library

```ts
import { resolve as github } from "@agntn/credentials/github";
import { resolve as cloudflare } from "@agntn/credentials/cloudflare";

console.log(github()?.source);

const cf = await cloudflare();
console.log(cf.source, new Date(cf.expiresAt).toISOString());
```

```
cli
cli 2026-11-12T01:49:57.174Z
```

Both came from the CLIs. No env, no config. The Cloudflare token is cached until a minute before that timestamp. Then `cf` gets asked again.

`list({ verify: true })` sits next to every `resolve`. It returns what the CLI prints, as records. No token in them, ever.

## 🗺️ Services

| Subpath                            | Env                                                             | CLI and config                                              |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `@agntn/credentials/github`        | `GH_TOKEN`, `GITHUB_TOKEN`                                      | `gh auth token`, `gh/hosts.yml`                             |
| `@agntn/credentials/gitlab`        | `GITLAB_TOKEN`, `GL_TOKEN`, `GITLAB_PAT`                        | `glab config get token`, `glab-cli/config.yml`              |
| `@agntn/credentials/gitea`         | `GITEA_TOKEN`                                                   | `tea login helper get`, `tea/config.yml`                    |
| `@agntn/credentials/gitee`         | `GITEE_TOKEN`, `GITEE_ACCESS_TOKEN`                             | none                                                        |
| `@agntn/credentials/sourcehut`     | `SRHT_TOKEN`                                                    | `hut/config`                                                |
| `@agntn/credentials/bitbucket`     | `BITBUCKET_TOKEN`, `BITBUCKET_API_TOKEN` with `BITBUCKET_EMAIL` | none                                                        |
| `@agntn/credentials/azure-devops`  | `AZURE_DEVOPS_EXT_PAT`                                          | `az devops` PAT file, default organization                  |
| `@agntn/credentials/pushin`        | `PUSHIN_TOKEN`                                                  | `pun/hosts.json`                                            |
| `@agntn/credentials/cursor-origin` | `CURSOR_AUTH_TOKEN`                                             | `origin auth token`, `origin-cli/credentials.json`          |
| `@agntn/credentials/gitcafe`       | `CAFE_TOKEN`                                                    | `cafe auth http credential get`, `gitcafe/credentials.json` |
| `@agntn/credentials/tangled`       | `TANGLED_HANDLE` with `TANGLED_PASSWORD`, `TANGLED_PDS_URL`     | none                                                        |
| `@agntn/credentials/cloudflare`    | `CLOUDFLARE_API_TOKEN`                                          | `cf auth whoami` OAuth session                              |

Nothing found? You get `null`. Honest answer. An empty `GH_TOKEN=` still counts and means anonymous.

Cloudflare is the one that throws. Branch on the `code` of `CredentialsError`, `"token"` or `"account"`, not the message. Got a 401? Call it again with `refresh: true`.

Two lookups do more than read a file. Sourcehut runs hut's `access-token-cmd`, so the token stays in `pass`. On Linux, Azure DevOps reads the plain text PAT file az falls back to. Keyring was plan A.

The exact order per service sits in the doc comments: [`src/core/forge.ts`](./src/core/forge.ts), [`src/tangled.ts`](./src/tangled.ts) and [`src/cloudflare.ts`](./src/cloudflare.ts).

## 🤖 Agents

```bash
pi install npm:@agntn/credentials
omp install @agntn/credentials
```

```json
{
  "mcpServers": {
    "credentials": { "command": "npx", "args": ["-y", "@agntn/credentials", "mcp"] }
  }
}
```

One tool, `credentials_list`, the same in MCP, Pi, OMP and the AI SDK (`@agntn/credentials/ai`). It takes `service` and `verify`. No host, so a model can't point your token somewhere else. A tool that returns tokens doesn't exist here, and won't.

## 🚫 What this does not do

It never logs you in. It never writes a token anywhere. It only finds what's already there.

## 🛠️ Development

```bash
pnpm install
pnpm test        # vp test run
pnpm lint        # build, vp lint, vp fmt --check
pnpm typecheck   # tsc on src and test
pnpm build       # obuild
```

## 💛 Thanks

This package gets built with help from [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). Thanks to both teams for backing open source work like this.

## 📄 License

[MIT](./LICENSE)
