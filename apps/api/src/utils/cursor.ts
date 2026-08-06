/**
 * Opaque cursor codec for keyset pagination.
 *
 * A cursor encodes the full sort key of the last row returned: a tuple
 * `[sortValue, uuid]`. `sortValue` is:
 *   - epoch milliseconds (number) for timestamp sort columns (created_at, last_seen_at),
 *   - the projection value (string | number | boolean-as-0/1) for filter/sort fields,
 *   - the sequence (number) for run items.
 *
 * The tuple is JSON-serialized and base64url-encoded so it is safe to pass in a
 * query string and carries no server state. Keyset predicates (built in the db
 * model) use both components, so pagination never skips or duplicates rows.
 */

export interface Cursor {
    /** Sort value of the last row (epoch millis for timestamps, or the raw projection/sequence value). */
    v: string | number | boolean | null;
    /** uuid tiebreaker of the last row. */
    id: string;
}

/**
 * Thrown when a client-supplied cursor cannot be decoded. Callers map this to a
 * 400 response (`invalid_cursor`).
 */
export class InvalidCursorError extends Error {
    constructor(message = "Invalid cursor") {
        super(message);
        this.name = "InvalidCursorError";
    }
}

/**
 * Encode a keyset cursor to an opaque base64url token.
 */
export function encodeCursor(cursor: Cursor): string {
    const payload = JSON.stringify([cursor.v ?? null, cursor.id]);
    return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor token back to its `{ v, id }` tuple.
 * Throws {@link InvalidCursorError} for anything that is not a well-formed token.
 */
export function decodeCursor(token: string): Cursor {
    if (typeof token !== "string" || token.length === 0) {
        throw new InvalidCursorError();
    }

    let decoded: string;
    try {
        decoded = Buffer.from(token, "base64url").toString("utf8");
    } catch {
        throw new InvalidCursorError();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        throw new InvalidCursorError();
    }

    if (!Array.isArray(parsed) || parsed.length !== 2) {
        throw new InvalidCursorError();
    }

    const [v, id] = parsed as [unknown, unknown];
    if (typeof id !== "string" || id.length === 0) {
        throw new InvalidCursorError();
    }
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new InvalidCursorError();
    }

    return { v: v as Cursor["v"], id };
}
