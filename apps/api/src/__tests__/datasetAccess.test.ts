import { describe, it, expect } from "@jest/globals";
import { resolveDatasetOwnerScope, buildDatasetWhereClause } from "@anycrawl/db";

/**
 * Owner-scoping precedence for dataset access. `resolveDatasetOwnerScope` is the
 * pure decision function underpinning `buildDatasetWhereClause`; testing it needs
 * no live database.
 */
describe("resolveDatasetOwnerScope", () => {
    it("prefers userId when both userId and apiKeyId are present", () => {
        expect(resolveDatasetOwnerScope({ userId: "user-1", apiKeyId: "key-1" })).toEqual({
            by: "user",
            value: "user-1",
        });
    });

    it("falls back to apiKeyId when userId is absent", () => {
        expect(resolveDatasetOwnerScope({ apiKeyId: "key-1" })).toEqual({
            by: "apiKey",
            value: "key-1",
        });
    });

    it("returns an unscoped result when neither is present", () => {
        expect(resolveDatasetOwnerScope({})).toEqual({ by: "none", value: null });
    });

    it("treats an empty-string userId as absent (falls back to apiKeyId)", () => {
        expect(resolveDatasetOwnerScope({ userId: "", apiKeyId: "key-1" })).toEqual({
            by: "apiKey",
            value: "key-1",
        });
    });
});

describe("buildDatasetWhereClause", () => {
    it("produces a SQL fragment for each owner scope without throwing", () => {
        expect(buildDatasetWhereClause("ds-1", { userId: "user-1", apiKeyId: "key-1" })).toBeTruthy();
        expect(buildDatasetWhereClause("ds-1", { apiKeyId: "key-1" })).toBeTruthy();
        expect(buildDatasetWhereClause("ds-1", {})).toBeTruthy();
    });
});
