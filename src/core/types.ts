/** Where a credential came from, in the order every resolver tries them. */
export type CredentialSource = "explicit" | "env" | "cli" | "config";

/** The services this package finds credentials for, in the order every surface lists them. */
export const SERVICES = ["github", "gitlab", "gitea", "gitee", "sourcehut", "cloudflare"] as const;

/** A service this package finds credentials for. */
export type Service = (typeof SERVICES)[number];

/**
 * What is known about a credential without showing it.
 *
 * - `unchecked`: found, not tested (`verify` was off, or there is no host to test it against)
 * - `valid`: the service accepted it
 * - `rejected`: the service refused it
 * - `expired`: past its recorded expiry, or the service says so
 * - `anonymous`: an empty value that asks for anonymous access
 * - `unreachable`: the check itself failed, so nothing is known
 */
export type CredentialState =
  | "unchecked"
  | "valid"
  | "rejected"
  | "expired"
  | "anonymous"
  | "unreachable";

/** One credential `list` found. It never carries the token. */
export interface CredentialInfo {
  readonly service: Service;
  /** The host the credential is for, and the only one `verify` sends it to. */
  readonly host: string;
  readonly source: CredentialSource;
  /** The variable, CLI or file it came from, such as `GH_TOKEN` or `gh`. */
  readonly origin: string;
  /** Whether `resolve` returns this credential for its host. */
  readonly active: boolean;
  readonly state: CredentialState;
  /** Login or email, from the CLI's records or from the service when verified. */
  readonly account?: string;
  /** Cloudflare: the account `resolve` would act on. */
  readonly accountId?: string;
  /** Cloudflare: where that account id came from. */
  readonly accountIdOrigin?: string;
  readonly scopes?: readonly string[];
  /** Milliseconds since the epoch. */
  readonly expiresAt?: number;
  /** Why the state is what it is, when the state alone doesn't say. */
  readonly note?: string;
}

export interface ListOptions {
  /** Ask each service whether it accepts the credential. Off by default: no network. */
  readonly verify?: boolean;
}
