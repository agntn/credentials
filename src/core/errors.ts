/** What a service lacks: a usable token, or one account to act on. */
export type CredentialsErrorCode = "token" | "account";

export interface CredentialsErrorOptions extends ErrorOptions {
  /** What is missing. */
  readonly code: CredentialsErrorCode;
}

/**
 * A service that needs a credential found none it could use.
 *
 * The message names what to set or run. It never quotes a token, a credentials file
 * or the output of a CLI, so it is safe to hand to a model.
 */
export class CredentialsError extends Error {
  override readonly name = "CredentialsError";
  /** The service the credential is for, such as `cloudflare`. */
  readonly service: string;
  /** Branch on this, not on the message, which may be reworded. */
  readonly code: CredentialsErrorCode;

  /**
   * @param service - The service the credential is for.
   * @param message - What is missing and how to provide it.
   * @param options - What is missing, and the underlying failure when it carries no secret.
   */
  constructor(service: string, message: string, options: Readonly<CredentialsErrorOptions>) {
    super(message, options);
    this.service = service;
    this.code = options.code;
  }
}
