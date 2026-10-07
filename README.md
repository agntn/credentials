# @agntn/credentials

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/credentials)](https://npmx.dev/package/@agntn/credentials)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/credentials)

🔑 Four services, one `resolve` each. You already logged in with `gh` and `cf`. Your code should notice.

## Why?

Every package that talks to GitHub or Cloudflare ends up with its own token hunt. One reads `GH_TOKEN`. Another shells out to `gh`. A third ignores `cf`, so `cf auth login` works in one package and not the next. This package does the hunt once, the same way everywhere.

## ✨ Features

- 🔗 **One chain, every service.** Explicit value, then env, then the CLI, then its config file.
- 🐙 **GitHub, GitLab, Gitea.** `gh`, `glab` and `tea` logins work as they are.
- 👥 **Pick a GitHub account.** Got two `gh` logins? Name one. The active login stays put.
- 🏠 **Self-hosted hosts.** Pass a `baseURL` and the CLI login for that host is used.
- ☁️ **Cloudflare without an API token.** The `cf` OAuth session is enough. It's read again once it expires.
- 🏷️ **Source on every result.** `explicit`, `env`, `cli` or `config`. Handy when the wrong token wins.
- 🤐 **Quiet errors.** No token, file content or CLI output ever lands in a message.

## 📦 Install

```bash
pnpm add @agntn/credentials
```

## 🚀 First call

```ts
import { resolve as github } from "@agntn/credentials/github";
import { resolve as cloudflare } from "@agntn/credentials/cloudflare";

console.log(github()?.source);

const cf = await cloudflare();
console.log(cf.source, new Date(cf.expiresAt).toISOString());
```

```
cli
cli 2026-10-07T18:25:49.939Z
```

Both came from the CLIs. No env, no config. The Cloudflare token is cached until a minute before that timestamp. Then `cf` gets asked again.

## 🗺️ Services

| Subpath                         | Env                                      | CLI and config                                 |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `@agntn/credentials/github`     | `GH_TOKEN`, `GITHUB_TOKEN`               | `gh auth token`, `gh/hosts.yml`                |
| `@agntn/credentials/gitlab`     | `GITLAB_TOKEN`, `GL_TOKEN`, `GITLAB_PAT` | `glab config get token`, `glab-cli/config.yml` |
| `@agntn/credentials/gitea`      | `GITEA_TOKEN`                            | `tea/config.yml`                               |
| `@agntn/credentials/cloudflare` | `CLOUDFLARE_API_TOKEN`                   | `cf auth whoami` OAuth session                 |

The forges return `null` when nothing turns up. An empty `GH_TOKEN=` still counts and means anonymous. Cloudflare throws `CredentialsError` instead, and the message says what to set.

Cloudflare also needs an account. It takes `accountId`, then `AGNTN_CLOUDFLARE_ACCOUNT_ID`, then `CLOUDFLARE_ACCOUNT_ID`. If none is set, the `cf` session's account is used. That only works when it reaches exactly one. Got a 401 back? Call it with `refresh: true`.

Everything else lives in the types: [`src/core/forge.ts`](./src/core/forge.ts) and [`src/cloudflare.ts`](./src/cloudflare.ts).

## 🚫 What this does not do

It never logs you in. It never writes a token anywhere. It only finds what's already there. There's no CLI and no MCP tool either. A tool that hands a token to a model is a leak.

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
