import { createHash } from "crypto";

/**
 * Pure document-hash + shallow-diff helpers for the Dataset Writer.
 *
 * These functions intentionally have NO database or drizzle dependency so they
 * can be unit-tested in isolation. They implement the normalization rules from
 * design doc §11.3 / §12:
 *
 *   1. object keys are sorted;
 *   2. array order is preserved;
 *   3. numbers are NOT stringified (a number and its string form hash differently);
 *   4. `hashExcludePaths` (JSON-pointer-like "/a/b" or bare "a") are removed before
 *      hashing so volatile platform run/time fields never flip the hash.
 *
 * The excluded platform fields themselves are decided by the caller (the Writer
 * passes its platform defaults merged with the mapping's `hashExcludePaths`); this
 * module only applies whatever path list it is given.
 */

/** Split a JSON-pointer-ish path ("/provenance/scrapedAt" or "jobId") into segments. */
function splitPath(path: string): string[] {
    return String(path)
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Deep clone a JSON-serializable value without mutating the source. */
function deepClone<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
}

/** Remove a single path (by segments) from an object in place. */
function removePath(target: unknown, segments: string[]): void {
    if (segments.length === 0) return;
    let node: any = target;
    for (let i = 0; i < segments.length - 1; i++) {
        if (node === null || typeof node !== "object") return;
        node = node[segments[i] as string];
    }
    const last = segments[segments.length - 1] as string;
    if (node !== null && typeof node === "object") {
        delete node[last];
    }
}

/**
 * Canonical, stable serialization used as the hash pre-image. Object keys sorted;
 * arrays preserved; numbers kept numeric; `undefined` / functions dropped.
 */
export function stableStringify(value: unknown): string {
    if (value === null) return "null";
    const t = typeof value;
    if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
    if (t === "boolean") return (value as boolean) ? "true" : "false";
    if (t === "bigint") return String(value);
    if (t === "string") return JSON.stringify(value);
    if (t !== "object") return "null"; // undefined / function / symbol
    if (Array.isArray(value)) {
        return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
    return (
        "{" +
        keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
        "}"
    );
}

/**
 * Compute the normalized document hash. `hashExcludePaths` entries are removed
 * from a deep copy before hashing so the source document is never mutated.
 */
export function computeDocumentHash(
    document: unknown,
    hashExcludePaths: string[] = []
): string {
    let normalized = document;
    if (document !== null && typeof document === "object" && hashExcludePaths.length > 0) {
        const clone = deepClone(document);
        for (const path of hashExcludePaths) {
            removePath(clone, splitPath(path));
        }
        normalized = clone;
    }
    return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

/**
 * Shallow (top-level) field diff between two documents. Returns only the changed
 * keys as `{ field: { before, after } }`. Nested equality uses the same stable
 * serialization as the hash, so ordering-only differences are not reported.
 */
export function shallowFieldDiff(
    before: unknown,
    after: unknown
): Record<string, { before: unknown; after: unknown }> {
    const result: Record<string, { before: unknown; after: unknown }> = {};
    const beforeObj =
        before !== null && typeof before === "object" && !Array.isArray(before)
            ? (before as Record<string, unknown>)
            : {};
    const afterObj =
        after !== null && typeof after === "object" && !Array.isArray(after)
            ? (after as Record<string, unknown>)
            : {};
    const keys = new Set<string>([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    for (const key of keys) {
        const b = beforeObj[key];
        const a = afterObj[key];
        if (stableStringify(b) !== stableStringify(a)) {
            result[key] = { before: b, after: a };
        }
    }
    return result;
}
