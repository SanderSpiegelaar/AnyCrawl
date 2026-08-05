import { describe, expect, it } from "@jest/globals";
import {
    isJsonPointer,
    validateOutputSchema,
    validateRuntime,
    validateVariablesSchema,
    validateTemplateContract,
    assertValidContractResult,
} from "../template/validate-contract.js";
import { TemplateValidationError } from "../types/template-config.js";

const expectOk = (res: ReturnType<typeof validateRuntime>) => {
    expect(res.ok).toBe(true);
};

const expectErrorMatching = (res: ReturnType<typeof validateRuntime>, pattern: RegExp) => {
    expect(res.ok).toBe(false);
    if (!res.ok) {
        expect(res.errors.some((e) => pattern.test(e))).toBe(true);
    }
};

describe("isJsonPointer", () => {
    it("accepts empty string and rooted pointers", () => {
        expect(isJsonPointer("")).toBe(true);
        expect(isJsonPointer("/items")).toBe(true);
        expect(isJsonPointer("/provenance/scrapedAt")).toBe(true);
        expect(isJsonPointer("/a~0b/c~1d")).toBe(true);
    });

    it("rejects non-pointers and bad escapes", () => {
        expect(isJsonPointer("items")).toBe(false);
        expect(isJsonPointer("id")).toBe(false);
        expect(isJsonPointer("/bad~2escape")).toBe(false);
        expect(isJsonPointer(42)).toBe(false);
    });
});

describe("validateOutputSchema", () => {
    it("accepts the craigslist_listing@1.0.0 schema", () => {
        const res = validateOutputSchema({
            name: "craigslist_listing",
            version: "1.0.0",
            itemsPath: "/items",
            itemKeyPath: "/itemKey",
            hashExcludePaths: ["/provenance/scrapedAt"],
            projections: [
                { field: "priceAmount", path: "/price/amount", type: "number" },
                { field: "cityCode", path: "/location/cityCode", type: "string" },
                { field: "postedAt", path: "/postedAt", type: "timestamptz" },
                { field: "hasImage", path: "/hasImage", type: "boolean" },
            ],
        });
        expectOk(res);
    });

    it("accepts a minimal schema (name + version only)", () => {
        expectOk(validateOutputSchema({ name: "example_item", version: "1.0.0" }));
    });

    it("rejects missing name/version", () => {
        const res = validateOutputSchema({ itemsPath: "/items" });
        expectErrorMatching(res, /name/);
        expectErrorMatching(res, /version/);
    });

    it("rejects non-pointer itemsPath / itemKeyPath / hashExcludePaths", () => {
        expectErrorMatching(
            validateOutputSchema({ name: "n", version: "1.0.0", itemsPath: "items" }),
            /itemsPath/
        );
        expectErrorMatching(
            validateOutputSchema({ name: "n", version: "1.0.0", itemKeyPath: "id" }),
            /itemKeyPath/
        );
        expectErrorMatching(
            validateOutputSchema({ name: "n", version: "1.0.0", hashExcludePaths: ["provenance/scrapedAt"] }),
            /hashExcludePaths/
        );
    });

    it("rejects a bad projection type and non-pointer projection path", () => {
        expectErrorMatching(
            validateOutputSchema({
                name: "n",
                version: "1.0.0",
                projections: [{ field: "x", path: "/x", type: "int" }],
            }),
            /projections\[0\]\.type/
        );
        expectErrorMatching(
            validateOutputSchema({
                name: "n",
                version: "1.0.0",
                projections: [{ field: "x", path: "x", type: "string" }],
            }),
            /projections\[0\]\.path/
        );
    });

    it("rejects non-object input", () => {
        expectErrorMatching(validateOutputSchema(null), /object/);
    });
});

describe("validateRuntime", () => {
    it("accepts single mode without a seedBuilder", () => {
        expectOk(validateRuntime({ mode: "single", seedBuilder: null }));
        expectOk(validateRuntime({ mode: "single" }));
    });

    it("accepts orchestrated mode with a handler seedBuilder", () => {
        expectOk(
            validateRuntime({
                mode: "orchestrated",
                handlerProtocolVersion: "1",
                seedBuilder: { type: "handler", name: "seedHandler" },
            })
        );
    });

    it("rejects orchestrated mode without a seedBuilder (publish fails)", () => {
        expectErrorMatching(validateRuntime({ mode: "orchestrated" }), /seedBuilder is required/);
    });

    it("rejects orchestrated seedBuilder with wrong type or empty name", () => {
        expectErrorMatching(
            validateRuntime({ mode: "orchestrated", seedBuilder: { type: "code", name: "x" } }),
            /seedBuilder\.type/
        );
        expectErrorMatching(
            validateRuntime({ mode: "orchestrated", seedBuilder: { type: "handler", name: "" } }),
            /seedBuilder\.name/
        );
    });

    it("rejects an invalid mode", () => {
        expectErrorMatching(validateRuntime({ mode: "parallel" }), /runtime\.mode/);
    });
});

describe("validateVariablesSchema", () => {
    it("accepts absent variables", () => {
        expectOk(validateVariablesSchema(undefined));
    });

    it("accepts the Craigslist variable set (enum[], string[], number range, enum)", () => {
        const res = validateVariablesSchema({
            cities: {
                type: "array",
                description: "Craigslist cities",
                required: true,
                minItems: 1,
                items: { type: "enum", values: ["sfbay", "newyork"] },
                defaultValue: ["sfbay"],
            },
            categories: {
                type: "array",
                description: "Categories",
                required: true,
                items: { type: "enum", enum: ["sss", "cta"] },
            },
            searchQueries: {
                type: "array",
                description: "Search queries",
                required: false,
                items: { type: "string" },
                defaultValue: ["iphone", "macbook"],
            },
            minPrice: { type: "number", description: "Min price", required: false, min: 0, max: 100000 },
            maxPrice: { type: "number", description: "Max price", required: false, min: 0 },
            hasPic: { type: "boolean", description: "Has picture", required: false, defaultValue: true },
            sort: {
                type: "enum",
                description: "Sort order",
                required: false,
                values: ["date", "default"],
                defaultValue: "date",
            },
        });
        expectOk(res);
    });

    it("rejects an unknown variable type", () => {
        expectErrorMatching(
            validateVariablesSchema({ x: { type: "object", description: "d", required: false } }),
            /invalid type/
        );
    });

    it("rejects an enum with no values", () => {
        expectErrorMatching(
            validateVariablesSchema({ sort: { type: "enum", description: "d", required: false } }),
            /enum must declare a non-empty/
        );
    });

    it("rejects an array variable without items", () => {
        expectErrorMatching(
            validateVariablesSchema({ tags: { type: "array", description: "d", required: false } }),
            /must declare 'items'/
        );
    });

    it("rejects an enum[] whose items enum is empty", () => {
        expectErrorMatching(
            validateVariablesSchema({
                cities: { type: "array", description: "d", required: true, items: { type: "enum" } },
            }),
            /items enum must declare a non-empty/
        );
    });

    it("rejects minItems > maxItems", () => {
        expectErrorMatching(
            validateVariablesSchema({
                cities: {
                    type: "array",
                    description: "d",
                    required: true,
                    minItems: 5,
                    maxItems: 2,
                    items: { type: "string" },
                },
            }),
            /minItems \(5\) greater than maxItems \(2\)/
        );
    });

    it("rejects min > max on a number variable", () => {
        expectErrorMatching(
            validateVariablesSchema({
                price: { type: "number", description: "d", required: false, min: 100, max: 10 },
            }),
            /min \(100\) greater than max \(10\)/
        );
    });

    it("rejects a defaultValue that does not match the declared type", () => {
        expectErrorMatching(
            validateVariablesSchema({
                hasPic: { type: "boolean", description: "d", required: false, defaultValue: "yes" },
            }),
            /defaultValue does not match type 'boolean'/
        );
        expectErrorMatching(
            validateVariablesSchema({
                sort: { type: "enum", description: "d", required: false, values: ["date"], defaultValue: "price" },
            }),
            /defaultValue does not match type 'enum'/
        );
    });

    it("rejects array defaultValue elements that do not match items type", () => {
        expectErrorMatching(
            validateVariablesSchema({
                cities: {
                    type: "array",
                    description: "d",
                    required: true,
                    items: { type: "enum", values: ["sfbay"] },
                    defaultValue: ["sfbay", "unknown"],
                },
            }),
            /defaultValue\[1\] does not match items\.type 'enum'/
        );
    });

    it("rejects a number defaultValue outside min/max", () => {
        expectErrorMatching(
            validateVariablesSchema({
                price: { type: "number", description: "d", required: false, min: 0, max: 10, defaultValue: 50 },
            }),
            /greater than max/
        );
    });
});

describe("validateTemplateContract", () => {
    it("aggregates errors across runtime, outputSchema, and variables", () => {
        const res = validateTemplateContract({
            runtime: { mode: "orchestrated" },
            outputSchema: { name: "n" },
            variables: { x: { type: "object", description: "d", required: false } },
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errors.length).toBeGreaterThanOrEqual(3);
        }
    });

    it("passes for a valid orchestrated Craigslist-style config", () => {
        const res = validateTemplateContract({
            runtime: { mode: "orchestrated", seedBuilder: { type: "handler", name: "seedHandler" } },
            outputSchema: {
                name: "craigslist_listing",
                version: "1.0.0",
                itemsPath: "/items",
                itemKeyPath: "/itemKey",
                hashExcludePaths: ["/provenance/scrapedAt"],
            },
            variables: {
                cities: { type: "array", description: "d", required: true, items: { type: "enum", values: ["sfbay"] } },
            },
        });
        expectOk(res);
    });
});

describe("assertValidContractResult", () => {
    it("throws TemplateValidationError on failure", () => {
        expect(() => assertValidContractResult({ ok: false, errors: ["a", "b"] })).toThrow(
            TemplateValidationError
        );
    });

    it("does not throw on success", () => {
        expect(() => assertValidContractResult({ ok: true })).not.toThrow();
    });
});
