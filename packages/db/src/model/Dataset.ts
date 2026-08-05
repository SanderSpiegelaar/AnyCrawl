import type { OwnerContext } from "@anycrawl/libs";
import { and, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { resolveDatasetOwnerScope } from "./DatasetAccess.js";

type DBExecutor = any;

const IS_SQLITE = process.env.ANYCRAWL_API_DB_TYPE?.toLowerCase() === "sqlite";

// Sentinel used to sort NULL run-item sequences deterministically last (max int32).
const SEQUENCE_NULLS_LAST = 2147483647;

export type FieldType = "string" | "number" | "boolean" | "timestamptz";
export type FilterOp = "eq" | "in" | "lt" | "lte" | "gt" | "gte";

export interface ItemFilter {
    field: string;
    fieldType: FieldType;
    op: FilterOp;
    /** Raw string value(s) from the query string; coerced to `fieldType` at bind time. */
    values: string[];
}

export interface ItemSort {
    field: string;
    fieldType: FieldType;
    dir: "asc" | "desc";
}

export interface CursorKey {
    v: string | number | boolean | null;
    id: string;
}

export interface PageResult {
    items: any[];
    nextCursor: CursorKey | null;
}

const OP_SQL: Record<Exclude<FilterOp, "in">, any> = {
    eq: sql`=`,
    lt: sql`<`,
    lte: sql`<=`,
    gt: sql`>`,
    gte: sql`>=`,
};

/** Drizzle column holding values of the given projection type. */
function typedColumn(fieldType: FieldType): any {
    switch (fieldType) {
        case "string":
            return schemas.datasetItemFieldValues.stringValue;
        case "number":
            return schemas.datasetItemFieldValues.numberValue;
        case "boolean":
            return schemas.datasetItemFieldValues.booleanValue;
        case "timestamptz":
            return schemas.datasetItemFieldValues.timestamptzValue;
    }
}

/** Coerce a raw query-string value to a driver-bindable value for its projection type. */
function coerceFilterValue(fieldType: FieldType, raw: string): any {
    switch (fieldType) {
        case "string":
            return String(raw);
        case "number":
            return Number(raw);
        case "boolean": {
            const b = raw === "true" || raw === "1";
            return IS_SQLITE ? (b ? 1 : 0) : b;
        }
        case "timestamptz": {
            const d = new Date(raw);
            return IS_SQLITE ? d.getTime() : d;
        }
    }
}

/** Coerce a cursor's stored sort value back to a driver-bindable value. */
function coerceCursorValue(fieldType: FieldType, v: CursorKey["v"]): any {
    switch (fieldType) {
        case "string":
            return v === null ? null : String(v);
        case "number":
            return v === null ? null : Number(v);
        case "boolean": {
            const b = v === true || v === 1 || v === "true" || v === "1";
            return IS_SQLITE ? (b ? 1 : 0) : b;
        }
        case "timestamptz":
            return v === null ? null : IS_SQLITE ? Number(v) : new Date(Number(v));
    }
}

/** Normalize a projection value read back from the DB into a compact cursor value. */
function projectionToCursorValue(fieldType: FieldType, dbVal: any): CursorKey["v"] {
    if (dbVal === null || dbVal === undefined) return null;
    switch (fieldType) {
        case "string":
            return String(dbVal);
        case "number":
            return Number(dbVal);
        case "boolean":
            return !!dbVal;
        case "timestamptz":
            if (dbVal instanceof Date) return dbVal.getTime();
            if (typeof dbVal === "number") return dbVal;
            return new Date(dbVal).getTime();
    }
}

/** EXISTS subquery correlating dataset_item_field_values to the outer dataset_items row. */
function filterExists(f: ItemFilter): any {
    const col = typedColumn(f.fieldType);
    let cmp: any;
    if (f.op === "in") {
        const bounds = f.values.map((raw) => sql`${coerceFilterValue(f.fieldType, raw)}`);
        cmp = sql`${col} IN (${sql.join(bounds, sql`, `)})`;
    } else {
        cmp = sql`${col} ${OP_SQL[f.op]} ${coerceFilterValue(f.fieldType, f.values[0] ?? "")}`;
    }
    return sql`EXISTS (SELECT 1 FROM ${schemas.datasetItemFieldValues}
        WHERE ${schemas.datasetItemFieldValues.datasetId} = ${schemas.datasetItems.datasetId}
          AND ${schemas.datasetItemFieldValues.itemKey} = ${schemas.datasetItems.itemKey}
          AND ${schemas.datasetItemFieldValues.fieldName} = ${f.field}
          AND ${cmp})`;
}

/** Correlated scalar subquery yielding an item's value for the sort field. */
function sortSubquery(sort: ItemSort): any {
    return sql`(SELECT ${typedColumn(sort.fieldType)} FROM ${schemas.datasetItemFieldValues}
        WHERE ${schemas.datasetItemFieldValues.datasetId} = ${schemas.datasetItems.datasetId}
          AND ${schemas.datasetItemFieldValues.itemKey} = ${schemas.datasetItems.itemKey}
          AND ${schemas.datasetItemFieldValues.fieldName} = ${sort.field}
        LIMIT 1)`;
}

/**
 * Keyset predicate for a real timestamp column (created_at / last_seen_at). The
 * cursor value is epoch millis; drizzle encodes the Date per dialect.
 */
function timestampKeyset(col: any, uuidCol: any, dir: "asc" | "desc", cursor: CursorKey): any {
    const d = new Date(Number(cursor.v));
    if (dir === "desc") {
        return or(lt(col, d), and(eq(col, d), lt(uuidCol, cursor.id)));
    }
    return or(gt(col, d), and(eq(col, d), gt(uuidCol, cursor.id)));
}

/** Keyset predicate for an arbitrary SQL sort expression (projection sort / sequence). */
function exprKeyset(expr: any, uuidCol: any, dir: "asc" | "desc", boundValue: any, id: string): any {
    if (dir === "desc") {
        return sql`(${expr} < ${boundValue} OR (${expr} = ${boundValue} AND ${uuidCol} < ${id}))`;
    }
    return sql`(${expr} > ${boundValue} OR (${expr} = ${boundValue} AND ${uuidCol} > ${id}))`;
}

function combine(conditions: any[]): any {
    return conditions.length === 1 ? conditions[0] : and(...conditions);
}

export class Dataset {
    /** Create a manually-owned dataset. */
    static async create(
        db: DBExecutor,
        params: {
            apiKeyId?: string | null;
            userId?: string | null;
            name: string;
            description?: string | null;
            sourceType?: string;
            sourceTemplateId?: string | null;
            schemaName: string;
            schemaVersion: string;
            retentionPolicy?: { item_days?: number; change_days?: number } | null;
        }
    ): Promise<any> {
        const now = new Date();
        const result = await db
            .insert(schemas.datasets)
            .values({
                apiKey: params.apiKeyId ?? null,
                userId: params.userId ?? null,
                name: params.name,
                description: params.description ?? null,
                sourceType: params.sourceType ?? "manual",
                sourceTemplateId: params.sourceTemplateId ?? null,
                schemaName: params.schemaName,
                schemaVersion: params.schemaVersion,
                retentionPolicy: params.retentionPolicy ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .returning();
        return result[0];
    }

    /** Patch mutable dataset fields (name / description / retention_policy). */
    static async update(
        db: DBExecutor,
        datasetId: string,
        patch: {
            name?: string;
            description?: string | null;
            retentionPolicy?: { item_days?: number; change_days?: number } | null;
        }
    ): Promise<any | null> {
        const updateData: any = { updatedAt: new Date() };
        if (patch.name !== undefined) updateData.name = patch.name;
        if (patch.description !== undefined) updateData.description = patch.description;
        if (patch.retentionPolicy !== undefined) updateData.retentionPolicy = patch.retentionPolicy;

        const result = await db
            .update(schemas.datasets)
            .set(updateData)
            .where(eq(schemas.datasets.uuid, datasetId))
            .returning();
        return result[0] || null;
    }

    /** Soft-delete a dataset (sets deleted_at; blocks it from all owner-scoped reads). */
    static async softDelete(db: DBExecutor, datasetId: string): Promise<void> {
        const now = new Date();
        await db
            .update(schemas.datasets)
            .set({ deletedAt: now, updatedAt: now })
            .where(eq(schemas.datasets.uuid, datasetId));
    }

    /** Owner-scoped dataset list, cursor on (created_at DESC, uuid DESC). */
    static async listByOwner(
        db: DBExecutor,
        owner: OwnerContext,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const scope = resolveDatasetOwnerScope(owner);
        const conditions: any[] = [sql`${schemas.datasets.deletedAt} IS NULL`];
        if (scope.by === "user") {
            conditions.push(eq(schemas.datasets.userId, scope.value as string));
        } else if (scope.by === "apiKey") {
            conditions.push(eq(schemas.datasets.apiKey, scope.value as string));
        }
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasets.createdAt, schemas.datasets.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasets)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasets.createdAt} DESC, ${schemas.datasets.uuid} DESC`)
            .limit(opts.limit + 1);

        return this.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** Distinct filterable/sortable projection fields declared for a dataset. */
    static async getProjectionFields(
        db: DBExecutor,
        datasetId: string
    ): Promise<Map<string, FieldType>> {
        const rows = await db
            .select({
                fieldName: schemas.datasetItemFieldValues.fieldName,
                fieldType: schemas.datasetItemFieldValues.fieldType,
            })
            .from(schemas.datasetItemFieldValues)
            .where(eq(schemas.datasetItemFieldValues.datasetId, datasetId))
            .groupBy(
                schemas.datasetItemFieldValues.fieldName,
                schemas.datasetItemFieldValues.fieldType
            );
        const map = new Map<string, FieldType>();
        for (const r of rows) {
            map.set(r.fieldName, r.fieldType as FieldType);
        }
        return map;
    }

    /**
     * Dataset items. Default order (last_seen_at DESC, uuid DESC); optional
     * projection filters (EXISTS) and projection sort with matching keyset cursor.
     */
    static async getItems(
        db: DBExecutor,
        opts: {
            datasetId: string;
            limit: number;
            cursor?: CursorKey | null;
            filters?: ItemFilter[];
            sort?: ItemSort | null;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetItems.datasetId, opts.datasetId)];
        for (const f of opts.filters ?? []) {
            conditions.push(filterExists(f));
        }

        if (opts.sort) {
            const expr = sortSubquery(opts.sort);
            const dir = opts.sort.dir;
            if (opts.cursor) {
                const bound = coerceCursorValue(opts.sort.fieldType, opts.cursor.v);
                conditions.push(exprKeyset(expr, schemas.datasetItems.uuid, dir, bound, opts.cursor.id));
            }
            const dirSql = dir === "desc" ? sql`DESC` : sql`ASC`;
            const rows = await db
                .select({ item: schemas.datasetItems, sortValue: expr })
                .from(schemas.datasetItems)
                .where(combine(conditions))
                .orderBy(sql`${expr} ${dirSql}, ${schemas.datasetItems.uuid} ${dirSql}`)
                .limit(opts.limit + 1);

            const hasMore = rows.length > opts.limit;
            const page = hasMore ? rows.slice(0, opts.limit) : rows;
            const last = page[page.length - 1];
            const nextCursor = hasMore && last
                ? { v: projectionToCursorValue(opts.sort.fieldType, last.sortValue), id: last.item.uuid }
                : null;
            return { items: page.map((r: any) => r.item), nextCursor };
        }

        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetItems.lastSeenAt, schemas.datasetItems.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetItems)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetItems.lastSeenAt} DESC, ${schemas.datasetItems.uuid} DESC`)
            .limit(opts.limit + 1);

        return this.finalizeTimestamp(rows, opts.limit, (r: any) => r.lastSeenAt);
    }

    /** Dataset runs, cursor on (created_at DESC, uuid DESC). */
    static async listRuns(
        db: DBExecutor,
        datasetId: string,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetRuns.datasetId, datasetId)];
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetRuns.createdAt, schemas.datasetRuns.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetRuns)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetRuns.createdAt} DESC, ${schemas.datasetRuns.uuid} DESC`)
            .limit(opts.limit + 1);

        return this.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** A single run scoped to its parent dataset. Null when not found / mismatched. */
    static async getRun(db: DBExecutor, datasetId: string, runId: string): Promise<any | null> {
        const rows = await db
            .select()
            .from(schemas.datasetRuns)
            .where(
                and(
                    eq(schemas.datasetRuns.uuid, runId),
                    eq(schemas.datasetRuns.datasetId, datasetId)
                )
            )
            .limit(1);
        return rows[0] || null;
    }

    /** Run members in deterministic order, cursor on (sequence, uuid) ascending. */
    static async listRunItems(
        db: DBExecutor,
        runId: string,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const seqExpr = sql`COALESCE(${schemas.datasetRunItems.sequence}, ${SEQUENCE_NULLS_LAST})`;
        const conditions: any[] = [eq(schemas.datasetRunItems.datasetRunId, runId)];
        if (opts.cursor) {
            conditions.push(
                exprKeyset(seqExpr, schemas.datasetRunItems.uuid, "asc", Number(opts.cursor.v), opts.cursor.id)
            );
        }
        const rows = await db
            .select({ item: schemas.datasetRunItems, sortValue: seqExpr })
            .from(schemas.datasetRunItems)
            .where(combine(conditions))
            .orderBy(sql`${seqExpr} ASC, ${schemas.datasetRunItems.uuid} ASC`)
            .limit(opts.limit + 1);

        const hasMore = rows.length > opts.limit;
        const page = hasMore ? rows.slice(0, opts.limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasMore && last
            ? { v: Number(last.sortValue), id: last.item.uuid }
            : null;
        return { items: page.map((r: any) => r.item), nextCursor };
    }

    /** Dataset change history, filterable, cursor on (created_at DESC, uuid DESC). */
    static async listChanges(
        db: DBExecutor,
        datasetId: string,
        opts: {
            limit: number;
            cursor?: CursorKey | null;
            datasetRunId?: string;
            scopeKey?: string;
            itemKey?: string;
            since?: Date;
            until?: Date;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetItemChanges.datasetId, datasetId)];
        if (opts.datasetRunId) conditions.push(eq(schemas.datasetItemChanges.datasetRunId, opts.datasetRunId));
        if (opts.scopeKey) conditions.push(eq(schemas.datasetItemChanges.scopeKey, opts.scopeKey));
        if (opts.itemKey) conditions.push(eq(schemas.datasetItemChanges.itemKey, opts.itemKey));
        if (opts.since) conditions.push(gte(schemas.datasetItemChanges.createdAt, opts.since));
        if (opts.until) conditions.push(lte(schemas.datasetItemChanges.createdAt, opts.until));
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetItemChanges.createdAt, schemas.datasetItemChanges.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetItemChanges)
            .where(combine(conditions))
            .orderBy(sql`${schemas.datasetItemChanges.createdAt} DESC, ${schemas.datasetItemChanges.uuid} DESC`)
            .limit(opts.limit + 1);

        return this.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** Run warnings, filterable by code/scope/item_key, cursor on (created_at DESC, uuid DESC). */
    static async listRunWarnings(
        db: DBExecutor,
        runId: string,
        opts: {
            limit: number;
            cursor?: CursorKey | null;
            code?: string;
            scope?: string;
            itemKey?: string;
        }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.runWarnings.datasetRunId, runId)];
        if (opts.code) conditions.push(eq(schemas.runWarnings.code, opts.code));
        if (opts.scope) conditions.push(eq(schemas.runWarnings.scope, opts.scope));
        if (opts.itemKey) conditions.push(eq(schemas.runWarnings.itemKey, opts.itemKey));
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.runWarnings.createdAt, schemas.runWarnings.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.runWarnings)
            .where(combine(conditions))
            .orderBy(sql`${schemas.runWarnings.createdAt} DESC, ${schemas.runWarnings.uuid} DESC`)
            .limit(opts.limit + 1);

        return this.finalizeTimestamp(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** Trim a limit+1 fetch and derive the next timestamp cursor from the last row. */
    private static finalizeTimestamp(
        rows: any[],
        limit: number,
        getDate: (row: any) => Date | number | null
    ): PageResult {
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items[items.length - 1];
        let nextCursor: CursorKey | null = null;
        if (hasMore && last) {
            const d = getDate(last);
            const millis = d instanceof Date ? d.getTime() : typeof d === "number" ? d : null;
            nextCursor = { v: millis, id: last.uuid };
        }
        return { items, nextCursor };
    }
}
