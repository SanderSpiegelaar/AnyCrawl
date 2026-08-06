import {
    validateSlug,
    validateSlugFormat,
    isSlugUniqueViolation,
    SlugValidationError,
    RESERVED_SLUGS,
    type SlugValidationDeps,
} from "../model/slug.js";

/**
 * Unit tests for slug write-path validation (design doc §5.7).
 *
 * The pure parts (format + reserved words) run with no database. The DB-backed
 * parts (anti-ambiguity + uniqueness) run against injected mock deps, so no live
 * database is required.
 */

function expectSlugError(fn: () => unknown, code: SlugValidationError["code"], httpStatus: number) {
    try {
        fn();
        throw new Error("Expected SlugValidationError to be thrown");
    } catch (error) {
        expect(error).toBeInstanceOf(SlugValidationError);
        const e = error as SlugValidationError;
        expect(e.code).toBe(code);
        expect(e.httpStatus).toBe(httpStatus);
    }
}

async function expectAsyncSlugError(
    fn: () => Promise<unknown>,
    code: SlugValidationError["code"],
    httpStatus: number
) {
    await expect(fn()).rejects.toBeInstanceOf(SlugValidationError);
    try {
        await fn();
    } catch (error) {
        const e = error as SlugValidationError;
        expect(e.code).toBe(code);
        expect(e.httpStatus).toBe(httpStatus);
    }
}

describe("validateSlugFormat (pure: format + reserved)", () => {
    it("accepts valid lowercase kebab slugs (2-64 chars, no edge hyphens)", () => {
        const valid = [
            "ab",
            "a1",
            "abc",
            "content-extractor",
            "craigslist-housing",
            "a-b-c",
            "9to5",
            "a".repeat(64),
            "a" + "-".repeat(62) + "b", // internal hyphens allowed, edges are alnum
        ];
        for (const slug of valid) {
            expect(validateSlugFormat(slug)).toBe(slug);
        }
    });

    it("rejects malformed slugs with SLUG_INVALID_FORMAT (400)", () => {
        const invalid = [
            "a", // single char (min 2)
            "", // empty
            "A", // single char + uppercase
            "AB", // uppercase
            "Content-Extractor", // uppercase
            "-abc", // leading hyphen
            "abc-", // trailing hyphen
            "-", // just a hyphen
            "--", // hyphens only
            "a_b", // underscore
            "a b", // space
            "café", // non-ascii
            "a.b", // dot
            "a".repeat(65), // too long
            "slug!", // punctuation
        ];
        for (const slug of invalid) {
            expectSlugError(() => validateSlugFormat(slug), "SLUG_INVALID_FORMAT", 400);
        }
    });

    it("rejects reserved route sub-path words with SLUG_RESERVED (400)", () => {
        for (const reserved of RESERVED_SLUGS) {
            expect(reserved).toMatch(/^[a-z0-9-]+$/); // sanity: reserved words are otherwise valid
            expectSlugError(() => validateSlugFormat(reserved), "SLUG_RESERVED", 400);
        }
        // Explicit coverage of the three documented reserved words.
        expectSlugError(() => validateSlugFormat("execute"), "SLUG_RESERVED", 400);
        expectSlugError(() => validateSlugFormat("runs"), "SLUG_RESERVED", 400);
        expectSlugError(() => validateSlugFormat("spec"), "SLUG_RESERVED", 400);
    });
});

describe("validateSlug (with injected DB deps)", () => {
    const noCollisionDeps: SlugValidationDeps = {
        templateIdExists: async () => false,
        getBySlug: async () => null,
    };

    it("resolves and returns the slug when there are no collisions", async () => {
        await expect(validateSlug("content-extractor", { deps: noCollisionDeps })).resolves.toBe(
            "content-extractor"
        );
    });

    it("still enforces format/reserved before hitting deps", async () => {
        await expectAsyncSlugError(
            () => validateSlug("Bad_Slug", { deps: noCollisionDeps }),
            "SLUG_INVALID_FORMAT",
            400
        );
        await expectAsyncSlugError(
            () => validateSlug("execute", { deps: noCollisionDeps }),
            "SLUG_RESERVED",
            400
        );
    });

    it("rejects a slug equal to an existing (other) templateId with 409", async () => {
        const deps: SlugValidationDeps = {
            templateIdExists: async (id) => id === "existing-template",
            getBySlug: async () => null,
        };
        await expectAsyncSlugError(
            () => validateSlug("existing-template", { deps }),
            "SLUG_CONFLICTS_TEMPLATE_ID",
            409
        );
    });

    it("allows a slug equal to the writer's own templateId (no ambiguity)", async () => {
        const deps: SlugValidationDeps = {
            templateIdExists: async (id) => id === "my-template",
            getBySlug: async () => null,
        };
        await expect(
            validateSlug("my-template", { selfTemplateId: "my-template", deps })
        ).resolves.toBe("my-template");
    });

    it("rejects a slug already owned by a different template with SLUG_CONFLICT (409)", async () => {
        const deps: SlugValidationDeps = {
            templateIdExists: async () => false,
            getBySlug: async (slug) => (slug === "taken" ? { templateId: "other-owner" } : null),
        };
        await expectAsyncSlugError(
            () => validateSlug("taken", { selfTemplateId: "me", deps }),
            "SLUG_CONFLICT",
            409
        );
    });

    it("allows re-setting a slug already owned by the same template (update no-op)", async () => {
        const deps: SlugValidationDeps = {
            templateIdExists: async () => false,
            getBySlug: async (slug) => (slug === "mine" ? { templateId: "me" } : null),
        };
        await expect(validateSlug("mine", { selfTemplateId: "me", deps })).resolves.toBe("mine");
    });
});

describe("isSlugUniqueViolation", () => {
    it("detects PostgreSQL unique_violation on the slug column", () => {
        expect(
            isSlugUniqueViolation({
                code: "23505",
                detail: "Key (slug)=(taken) already exists.",
                constraint: "templates_slug_unique",
            })
        ).toBe(true);
    });

    it("detects SQLite unique constraint on templates.slug", () => {
        expect(
            isSlugUniqueViolation({ message: "UNIQUE constraint failed: templates.slug" })
        ).toBe(true);
    });

    it("does not match a templateId unique violation", () => {
        expect(
            isSlugUniqueViolation({
                code: "23505",
                detail: "Key (template_id)=(foo) already exists.",
                constraint: "templates_template_id_unique",
            })
        ).toBe(false);
        expect(
            isSlugUniqueViolation({ message: "UNIQUE constraint failed: templates.template_id" })
        ).toBe(false);
    });

    it("does not match unrelated errors", () => {
        expect(isSlugUniqueViolation(null)).toBe(false);
        expect(isSlugUniqueViolation(new Error("connection reset"))).toBe(false);
        expect(isSlugUniqueViolation({ code: "23503" })).toBe(false);
    });
});
