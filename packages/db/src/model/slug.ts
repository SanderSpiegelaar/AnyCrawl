/**
 * Vanity slug write-path validation (design doc §5.7).
 *
 * A template's `slug` is a nullable, globally-unique, human-friendly identifier
 * used to build dedicated endpoints like `POST /v1/template/{slug}/execute`.
 * `Template.resolveByRef(ref)` resolves slug-first, then templateId. To keep that
 * resolution deterministic (and to keep every templateId reachable), we validate
 * the slug at the model write choke point so the slug<->templateId ambiguity is
 * eliminated at the source.
 *
 * The checks are split so the pure parts (format + reserved words) are testable
 * without a database, and the DB-backed parts (anti-ambiguity + uniqueness) take
 * their lookups via injectable deps.
 */

/**
 * Lowercase kebab-case, 2-64 chars, no leading/trailing hyphen.
 *
 * NOTE (doc discrepancy, surfaced intentionally): §5.7 prose says "2–64 位"
 * (2-64 chars) but the literal regex printed there,
 * `^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$`, actually ACCEPTS a single char and
 * REJECTS any 2-char slug (the optional group needs >=2 chars, creating a gap at
 * length 2). That contradicts both the doc's own "2–64" prose and this task's
 * "min 2 chars" requirement. We implement the corrected form below, which matches
 * the documented intent: 2-64 chars, no leading/trailing hyphen. Recommend the
 * doc's literal regex be fixed to match.
 */
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/;

export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 64;

/**
 * Reserved words that must never be usable as a slug, because they are route
 * sub-path segments under `/v1/template/{ref}/...` (`/execute`, `/runs`, `/spec`).
 * Allowing them as slugs would risk future route-vs-slug collisions.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["execute", "runs", "spec"]);

export type SlugValidationErrorCode =
    | "SLUG_INVALID_FORMAT"
    | "SLUG_RESERVED"
    | "SLUG_CONFLICTS_TEMPLATE_ID"
    | "SLUG_CONFLICT";

/**
 * Typed error thrown by slug validation. Carries a stable `code` and a suggested
 * `httpStatus` so API callers can map cleanly to HTTP 400/409 without string
 * matching. `400` = malformed input (format/reserved); `409` = collision with an
 * existing resource (duplicate slug, or slug shadowing another template's id).
 */
export class SlugValidationError extends Error {
    readonly code: SlugValidationErrorCode;
    readonly httpStatus: number;
    readonly slug: string;

    constructor(code: SlugValidationErrorCode, slug: string, message: string, httpStatus: number) {
        super(message);
        this.name = "SlugValidationError";
        this.code = code;
        this.slug = slug;
        this.httpStatus = httpStatus;
        // Restore prototype chain (TS target ES2022 extending built-in Error).
        Object.setPrototypeOf(this, SlugValidationError.prototype);
    }
}

/**
 * Pure, DB-free validation: format + reserved-word blacklist.
 * Returns the slug unchanged on success; throws {@link SlugValidationError} otherwise.
 */
export function validateSlugFormat(slug: string): string {
    if (typeof slug !== "string") {
        throw new SlugValidationError(
            "SLUG_INVALID_FORMAT",
            String(slug),
            "Template slug must be a string.",
            400
        );
    }
    if (!SLUG_REGEX.test(slug)) {
        throw new SlugValidationError(
            "SLUG_INVALID_FORMAT",
            slug,
            `Invalid template slug "${slug}". Must be lowercase kebab-case, ${SLUG_MIN_LENGTH}-${SLUG_MAX_LENGTH} chars, using [a-z0-9-] with no leading or trailing hyphen.`,
            400
        );
    }
    if (RESERVED_SLUGS.has(slug)) {
        throw new SlugValidationError(
            "SLUG_RESERVED",
            slug,
            `Template slug "${slug}" is reserved and cannot be used.`,
            400
        );
    }
    return slug;
}

/**
 * DB lookups required for the anti-ambiguity and uniqueness checks. Injected so
 * validation is testable without a live database.
 */
export interface SlugValidationDeps {
    /** True if a template with this templateId already exists (anti-ambiguity). */
    templateIdExists(templateId: string): Promise<boolean>;
    /** The current owner of this slug, or null if unused (uniqueness). */
    getBySlug(slug: string): Promise<{ templateId: string } | null>;
}

export interface ValidateSlugOptions {
    /**
     * The templateId of the row being written. A slug is allowed to equal (or
     * already belong to) this same template — that is not a conflict. On create,
     * pass the new templateId; on update, pass the templateId being updated.
     */
    selfTemplateId?: string;
    deps: SlugValidationDeps;
}

/**
 * Full write-path validation: format + reserved + anti-ambiguity + uniqueness.
 * Returns the validated slug on success; throws {@link SlugValidationError} otherwise.
 *
 * - Anti-ambiguity: the slug must not equal any *other* template's templateId,
 *   otherwise `resolveByRef` would shadow that template (slug wins), making it
 *   unreachable by its own id.
 * - Uniqueness: the slug must not already be owned by a *different* template.
 */
export async function validateSlug(slug: string, opts: ValidateSlugOptions): Promise<string> {
    const validated = validateSlugFormat(slug);
    const { selfTemplateId, deps } = opts;

    // Anti-ambiguity: reject if the slug collides with a different template's id.
    if (validated !== selfTemplateId && (await deps.templateIdExists(validated))) {
        throw new SlugValidationError(
            "SLUG_CONFLICTS_TEMPLATE_ID",
            validated,
            `Template slug "${validated}" conflicts with an existing template id and would make that template unreachable.`,
            409
        );
    }

    // Uniqueness: reject if another template already owns this slug.
    const owner = await deps.getBySlug(validated);
    if (owner && owner.templateId !== selfTemplateId) {
        throw new SlugValidationError(
            "SLUG_CONFLICT",
            validated,
            `Template slug "${validated}" is already in use.`,
            409
        );
    }

    return validated;
}

/**
 * Detects whether a raw DB error is a unique-constraint violation on the `slug`
 * column, so the model can rethrow it as a clean {@link SlugValidationError}
 * (409) instead of leaking a driver error. Covers both PostgreSQL (pg, code
 * 23505) and SQLite (better-sqlite3). templateId unique violations are NOT
 * matched here, so they surface unchanged.
 */
export function isSlugUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: unknown; detail?: unknown; constraint?: unknown; message?: unknown };
    const detail = typeof e.detail === "string" ? e.detail : "";
    const constraint = typeof e.constraint === "string" ? e.constraint : "";
    const message = typeof e.message === "string" ? e.message : "";

    // PostgreSQL: unique_violation. Confirm it references the slug column.
    if (e.code === "23505") {
        return /\bslug\b/i.test(detail) || /slug/i.test(constraint);
    }
    // SQLite (better-sqlite3): "UNIQUE constraint failed: templates.slug"
    if (/UNIQUE constraint failed/i.test(message)) {
        return /\.slug\b/i.test(message);
    }
    return false;
}
