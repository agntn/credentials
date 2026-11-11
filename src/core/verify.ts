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

/** What to send, and which answers mean no. */
export interface ProbeRequest {
  /** The full `Authorization` header value. */
  readonly authorization: string;
  /** Statuses that mean the service refused the token. Defaults to 401 and 403. */
  readonly refusals?: readonly number[];
  /** A JSON body, which turns the GET into a POST, for a GraphQL endpoint. */
  readonly body?: string;
}

/**
 * Send one authenticated request and classify the answer.
 * @param url - Endpoint on the credential's own host.
 * @param request - The header, the refusal statuses and an optional body.
 * @returns {Promise<Probe>} The state, plus the response parts a caller may read.
 */
export async function probe(url: string, request: ProbeRequest): Promise<Probe> {
  const { authorization, refusals = [401, 403], body: query } = request;
  let response: Response;
  try {
    response = await fetch(url, {
      ...(query === undefined ? {} : { method: "POST", body: query }),
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "User-Agent": "@agntn/credentials",
        ...(query === undefined ? {} : { "Content-Type": "application/json" }),
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
