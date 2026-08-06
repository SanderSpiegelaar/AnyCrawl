import type { OwnerContext } from "@anycrawl/libs";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import type { CursorKey, PageResult } from "./Dataset.js";

type DBExecutor = any;

/**
 * Pure owner-scope resolver for Template Runs. Precedence mirrors Dataset: a
 * concrete `userId` wins, otherwise `apiKeyId`, otherwise unscoped. Kept
 * DB-agnostic so it is unit-testable without a database.
 */
export function resolveTemplateRunOwnerScope(
    owner: OwnerContext
): { by: "user" | "apiKey" | "none"; value: string | null } {
    if (owner.userId) {
        return { by: "user", value: owner.userId };
    }
    if (owner.apiKeyId) {
        return { by: "apiKey", value: owner.apiKeyId };
    }
    return { by: "none", value: null };
}

/**
 * Build the WHERE clause that scopes a single Template Run to its owner. A
 * cross-owner run never matches, so the caller emits a 404 without leaking the
 * run's existence. Template Runs are not soft-deleted, so there is no
 * `deleted_at` predicate (unlike Dataset).
 */
export function buildTemplateRunWhereClause(runId: string, owner: OwnerContext): any {
    const scope = resolveTemplateRunOwnerScope(owner);

    if (scope.by === "user") {
        return sql`${schemas.templateRuns.uuid} = ${runId} AND ${schemas.templateRuns.userId} = ${scope.value}`;
    }
    if (scope.by === "apiKey") {
        return sql`${schemas.templateRuns.uuid} = ${runId} AND ${schemas.templateRuns.apiKey} = ${scope.value}`;
    }
    return sql`${schemas.templateRuns.uuid} = ${runId}`;
}

/**
 * Fetch a single owned Template Run. Returns null when it does not exist or
 * belongs to another owner. Nested resources (events, warnings) resolve the
 * parent through this first so cross-owner reads never leak.
 */
export async function getOwnedTemplateRun(
    db: DBExecutor,
    runId: string,
    owner: OwnerContext
): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.templateRuns)
        .where(buildTemplateRunWhereClause(runId, owner))
        .limit(1);

    return rows[0] || null;
}

/**
 * Owner-scoped Template Run list, cursor on (created_at DESC, uuid DESC).
 * Optionally narrowed to a single template. Backed by the owner list indexes
 * `ix_template_run_{user,apikey}_created` (§11.9 rule 2).
 */
export async function listTemplateRunsByOwner(
    db: DBExecutor,
    owner: OwnerContext,
    opts: { limit: number; cursor?: CursorKey | null; templateUuid?: string | null }
): Promise<PageResult> {
    const scope = resolveTemplateRunOwnerScope(owner);
    const conditions: any[] = [];
    if (scope.by === "user") {
        conditions.push(eq(schemas.templateRuns.userId, scope.value as string));
    } else if (scope.by === "apiKey") {
        conditions.push(eq(schemas.templateRuns.apiKey, scope.value as string));
    }
    if (opts.templateUuid) {
        conditions.push(eq(schemas.templateRuns.templateUuid, opts.templateUuid));
    }
    if (opts.cursor) {
        const d = new Date(Number(opts.cursor.v));
        conditions.push(
            or(
                lt(schemas.templateRuns.createdAt, d),
                and(eq(schemas.templateRuns.createdAt, d), lt(schemas.templateRuns.uuid, opts.cursor.id))
            )
        );
    }

    const where =
        conditions.length === 0
            ? sql`1 = 1`
            : conditions.length === 1
                ? conditions[0]
                : and(...conditions);
    const rows = await db
        .select()
        .from(schemas.templateRuns)
        .where(where)
        .orderBy(sql`${schemas.templateRuns.createdAt} DESC, ${schemas.templateRuns.uuid} DESC`)
        .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    let nextCursor: CursorKey | null = null;
    if (hasMore && last) {
        const d = last.createdAt;
        const millis = d instanceof Date ? d.getTime() : typeof d === "number" ? d : null;
        nextCursor = { v: millis, id: last.uuid };
    }
    return { items, nextCursor };
}

/**
 * List a Template Run's warnings (§6.2 rule 8), cursor on (created_at DESC,
 * uuid DESC), optionally filtered by code/scope/item_key. Reads the shared
 * `run_warnings` table by its `template_run_uuid` link (populated by the Legacy
 * Run Adapter when a run writes a dataset), which is the run-scoped counterpart
 * to DatasetController's dataset-run-scoped warnings feed. Backed by
 * `ix_run_warnings_template_run`.
 */
export async function listTemplateRunWarnings(
    db: DBExecutor,
    templateRunUuid: string,
    opts: {
        limit: number;
        cursor?: CursorKey | null;
        code?: string;
        scope?: string;
        itemKey?: string;
    }
): Promise<PageResult> {
    const conditions: any[] = [eq(schemas.runWarnings.templateRunUuid, templateRunUuid)];
    if (opts.code) conditions.push(eq(schemas.runWarnings.code, opts.code));
    if (opts.scope) conditions.push(eq(schemas.runWarnings.scope, opts.scope));
    if (opts.itemKey) conditions.push(eq(schemas.runWarnings.itemKey, opts.itemKey));
    if (opts.cursor) {
        const d = new Date(Number(opts.cursor.v));
        conditions.push(
            or(
                lt(schemas.runWarnings.createdAt, d),
                and(eq(schemas.runWarnings.createdAt, d), lt(schemas.runWarnings.uuid, opts.cursor.id))
            )
        );
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = await db
        .select()
        .from(schemas.runWarnings)
        .where(where)
        .orderBy(sql`${schemas.runWarnings.createdAt} DESC, ${schemas.runWarnings.uuid} DESC`)
        .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    let nextCursor: CursorKey | null = null;
    if (hasMore && last) {
        const d = last.createdAt;
        const millis = d instanceof Date ? d.getTime() : typeof d === "number" ? d : null;
        nextCursor = { v: millis, id: last.uuid };
    }
    return { items, nextCursor };
}
