import type { OwnerContext } from "@anycrawl/libs";
import { sql } from "drizzle-orm";
import { schemas } from "../db/index.js";

type DBExecutor = any;

/**
 * Pure owner-scope resolver. Precedence: a concrete `userId` wins; otherwise fall
 * back to `apiKeyId`; otherwise unscoped. Kept DB-agnostic (no drizzle / schema
 * refs) so it is unit-testable without a database.
 */
export function resolveDatasetOwnerScope(
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
 * Build the WHERE clause that scopes a single dataset to its owner and excludes
 * soft-deleted rows. Cross-owner or deleted datasets never match, so the caller
 * emits a 404 (never leaking existence).
 */
export function buildDatasetWhereClause(datasetId: string, owner: OwnerContext): any {
    const notDeleted = sql`${schemas.datasets.deletedAt} IS NULL`;
    const scope = resolveDatasetOwnerScope(owner);

    if (scope.by === "user") {
        return sql`${schemas.datasets.uuid} = ${datasetId} AND ${schemas.datasets.userId} = ${scope.value} AND ${notDeleted}`;
    }
    if (scope.by === "apiKey") {
        return sql`${schemas.datasets.uuid} = ${datasetId} AND ${schemas.datasets.apiKey} = ${scope.value} AND ${notDeleted}`;
    }
    return sql`${schemas.datasets.uuid} = ${datasetId} AND ${notDeleted}`;
}

/**
 * Fetch a single owned, non-deleted dataset. Returns null when it does not exist,
 * is soft-deleted, or belongs to another owner. Nested resources (runs, items,
 * changes, warnings) resolve the parent through this first.
 */
export async function getOwnedDataset(
    db: DBExecutor,
    datasetId: string,
    owner: OwnerContext
): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.datasets)
        .where(buildDatasetWhereClause(datasetId, owner))
        .limit(1);

    return rows[0] || null;
}

/**
 * Fetch a dataset by id ignoring ownership (still excludes soft-deleted rows).
 * Used by internal callers that have already authorized the owner.
 */
export async function getDataset(db: DBExecutor, datasetId: string): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.datasets)
        .where(sql`${schemas.datasets.uuid} = ${datasetId} AND ${schemas.datasets.deletedAt} IS NULL`)
        .limit(1);

    return rows[0] || null;
}
