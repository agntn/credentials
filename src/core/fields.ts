/**
 * Drop the keys whose value is undefined, so an optional field is absent rather than
 * present and empty in a result and its JSON.
 * @param value - An object with optional fields.
 * @returns {T} The same fields, without the undefined ones.
 */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Read a date the way services and CLIs write it.
 * @param value - An ISO string or anything else.
 * @returns {number | undefined} Milliseconds since the epoch, or undefined when it isn't a date.
 */
export function epoch(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
