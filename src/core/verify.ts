/**
 * Ask a service whether it accepts a token.
 *
 * Only the status, a few headers and the named body fields are read. Nothing from the
 * response is echoed whole, and the token goes only to the URL the caller built from
 * the credential's own host.
 */

import { isRecord, nonEmptyString } from "./fields.ts";

const VERIFY_TIMEOUT_MS = 10_000;

/** An accepted token comes with the parts a caller reads; a refused or failed one with a reason. */
export type Probe =
  | { readonly state: "valid"; readonly headers: Headers; readonly body: unknown }
  | { readonly state: "rejected" | "unreachable"; readonly note: string };

/**
 * Send one authenticated GET and classify the answer.
 * @param url - Endpoint on the credential's own host.
 * @param authorization - The full `Authorization` header value.
 * @param refusals - Statuses that mean the service refused the token.
 * @returns {Promise<Probe>} The state, plus the response parts a caller may read.
 */
export async function probe(
  url: string,
  authorization: string,
  refusals: readonly number[] = [401, 403],
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "User-Agent": "@agntn/credentials",
      },
      redirect: "error",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    return { state: "unreachable", note: reasonOf(error) };
  }
  const note = `HTTP ${response.status}`;
  if (refusals.includes(response.status)) return { state: "rejected", note };
  if (!response.ok) return { state: "unreachable", note };
  const body: unknown = await response.json().catch(() => undefined);
  return { state: "valid", headers: response.headers, body };
}

/**
 * Name a network failure without its message, which may quote the URL.
 * @param error - What `fetch` threw.
 * @returns {string} A short reason.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  return "request failed";
}

/**
 * Read a string field of a JSON object.
 * @param body - Parsed response body.
 * @param key - Field name.
 * @returns {string | undefined} The value when it is a non-empty string.
 */
export function field(body: unknown, key: string): string | undefined {
  return isRecord(body) ? nonEmptyString(body[key]) : undefined;
}
