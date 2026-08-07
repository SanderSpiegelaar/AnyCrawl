import { jest, describe, it, expect } from "@jest/globals";

/**
 * Regression tests for the `array` variable type (live integration bug #2).
 *
 * The request-time variable validator `validateVariables` (apps/api/src/utils/
 * templateHandler.ts) switched on `definition.type` and fell through to a `default`
 * branch that threw `Variable '…' has unknown type 'array'`. Orchestrated templates
 * (e.g. a `cities: string[]` variable) were therefore rejected 400 invalid_variables
 * even for well-formed arrays. The fix adds a `case "array"` that validates element
 * type (string / number / boolean / url / enum), enum membership, and min/maxItems.
 *
 * templateHandler pulls in several heavy workspace modules at load time; the pure
 * `validateVariables` needs none of them, so we stub them (unstable_mockModule) to
 * keep this a fast, hermetic unit test — then dynamically import the real function.
 */
jest.unstable_mockModule("@anycrawl/db", () => ({ getTemplate: jest.fn() }));
jest.unstable_mockModule("@anycrawl/scrape", () => ({ AVAILABLE_ENGINES: ["cheerio", "playwright"] }));
jest.unstable_mockModule("@anycrawl/template-client", () => ({
    TemplateClient: class {},
    DomainValidator: class {},
    TemplateExecutionError: class extends Error {},
}));
jest.unstable_mockModule("@anycrawl/libs", () => ({
    TemplateScrapeSchema: {},
    TemplateCrawlSchema: {},
    TemplateSearchSchema: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
// templateHandler imports "./optionMerger.js"; resolve it relative to this test file.
jest.unstable_mockModule("../utils/optionMerger.js", () => ({ mergeOptionsWithTemplate: jest.fn() }));

const { validateVariables } = await import("../utils/templateHandler.js");

/** Capture the thrown validation message (or "" when it did not throw). */
function messageFrom(defs: any, provided: any): string {
    try {
        validateVariables(defs, provided);
        return "";
    } catch (e: any) {
        return e?.message ?? "";
    }
}

describe("validateVariables — array variable type (regression: 'unknown type array')", () => {
    // A string[] var + an enum[] var — the orchestrated-template shape that 400'd pre-fix.
    const defs: any = {
        cities: { type: "array", required: true, items: { type: "string" } },
        categories: { type: "array", required: false, items: { type: "enum", values: ["cars", "housing", "jobs"] } },
    };

    it("accepts a valid string[] and enum[] without throwing", () => {
        // PRIMARY GUARD: pre-fix this threw "unknown type 'array'".
        expect(() =>
            validateVariables(defs, { cities: ["sfbay", "nyc"], categories: ["cars", "jobs"] })
        ).not.toThrow();
    });

    it("treats 'array' as a KNOWN type — never falls through to 'unknown type'", () => {
        // A non-array value must be reported as an array-shape error, not "unknown type".
        const msg = messageFrom(defs, { cities: "sfbay" });
        expect(msg).toMatch(/must be an array/);
        expect(msg).not.toMatch(/unknown type/);
    });

    it("rejects a non-array value for an array variable", () => {
        expect(() => validateVariables(defs, { cities: 123 })).toThrow(/must be an array/);
    });

    it("rejects an element whose type does not match items.type (string)", () => {
        expect(() => validateVariables(defs, { cities: [123] })).toThrow(/must be a string/);
    });

    it("rejects an enum[] element outside the allowed set", () => {
        expect(() =>
            validateVariables(defs, { cities: ["ok"], categories: ["cars", "spaceship"] })
        ).toThrow(/must be one of/);
    });

    it("supports enum[] declared via items.values (no explicit items.type)", () => {
        const d: any = { tags: { type: "array", items: { values: ["x", "y"] } } };
        expect(() => validateVariables(d, { tags: ["x", "y"] })).not.toThrow();
        expect(() => validateVariables(d, { tags: ["z"] })).toThrow(/must be one of/);
    });

    it("enforces minItems / maxItems bounds", () => {
        const d: any = { cities: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } };
        expect(() => validateVariables(d, { cities: [] })).toThrow(/at least 1 item/);
        expect(() => validateVariables(d, { cities: ["a", "b", "c"] })).toThrow(/at most 2 item/);
        expect(() => validateVariables(d, { cities: ["a"] })).not.toThrow();
    });
});
