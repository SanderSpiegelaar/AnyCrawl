import { computeDocumentHash, shallowFieldDiff, stableStringify } from "../model/documentHash.js";

/**
 * Pure unit tests for the Dataset Writer's hashing/normalization (§11.3 / §12):
 * object key order is irrelevant, array order is significant, numbers are not
 * stringified, and `hashExcludePaths` are removed before hashing.
 */
describe("computeDocumentHash", () => {
    it("is invariant to object key order", () => {
        const a = { url: "https://x.test", title: "T", price: 10 };
        const b = { price: 10, title: "T", url: "https://x.test" };
        expect(computeDocumentHash(a)).toBe(computeDocumentHash(b));
    });

    it("is invariant to key order at any nesting depth", () => {
        const a = { meta: { b: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
        const b = { list: [{ x: 2, y: 1 }], meta: { a: 2, b: 1 } };
        expect(computeDocumentHash(a)).toBe(computeDocumentHash(b));
    });

    it("is sensitive to array order (order preserved)", () => {
        const a = { tags: ["a", "b", "c"] };
        const b = { tags: ["c", "b", "a"] };
        expect(computeDocumentHash(a)).not.toBe(computeDocumentHash(b));
    });

    it("distinguishes a number from its string form", () => {
        const asNumber = { price: 10 };
        const asString = { price: "10" };
        expect(computeDocumentHash(asNumber)).not.toBe(computeDocumentHash(asString));
        // And number formatting is stable/numeric.
        expect(stableStringify({ price: 10 })).toBe('{"price":10}');
        expect(stableStringify({ price: "10" })).toBe('{"price":"10"}');
    });

    it("ignores excluded top-level paths", () => {
        const base = { url: "https://x.test", title: "T" };
        const withVolatile = { url: "https://x.test", title: "T", jobId: "abc", timestamp: 12345 };
        expect(computeDocumentHash(withVolatile, ["/jobId", "/timestamp"])).toBe(
            computeDocumentHash(base, ["/jobId", "/timestamp"])
        );
    });

    it("ignores excluded nested paths (JSON-pointer style)", () => {
        const v1 = { title: "T", provenance: { scrapedAt: "2026-01-01", source: "s" } };
        const v2 = { title: "T", provenance: { scrapedAt: "2026-02-02", source: "s" } };
        expect(computeDocumentHash(v1, ["/provenance/scrapedAt"])).toBe(
            computeDocumentHash(v2, ["/provenance/scrapedAt"])
        );
        // Without the exclusion, the volatile field flips the hash.
        expect(computeDocumentHash(v1)).not.toBe(computeDocumentHash(v2));
    });

    it("accepts a bare (leading-slash-less) exclude path", () => {
        const a = { title: "T", jobId: "1" };
        const b = { title: "T", jobId: "2" };
        expect(computeDocumentHash(a, ["jobId"])).toBe(computeDocumentHash(b, ["jobId"]));
    });

    it("does not mutate the source document", () => {
        const doc = { title: "T", jobId: "keep-me" };
        computeDocumentHash(doc, ["/jobId"]);
        expect(doc.jobId).toBe("keep-me");
    });

    it("returns a stable 64-char hex sha256 digest", () => {
        const h = computeDocumentHash({ a: 1 });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("shallowFieldDiff", () => {
    it("reports only the changed top-level keys", () => {
        const before = { title: "old", price: 10, url: "u" };
        const after = { title: "new", price: 10, url: "u" };
        expect(shallowFieldDiff(before, after)).toEqual({
            title: { before: "old", after: "new" },
        });
    });

    it("captures added and removed keys", () => {
        const before = { a: 1 };
        const after = { b: 2 };
        expect(shallowFieldDiff(before, after)).toEqual({
            a: { before: 1, after: undefined },
            b: { before: undefined, after: 2 },
        });
    });

    it("treats key-order-only nested differences as equal", () => {
        const before = { meta: { a: 1, b: 2 } };
        const after = { meta: { b: 2, a: 1 } };
        expect(shallowFieldDiff(before, after)).toEqual({});
    });
});
