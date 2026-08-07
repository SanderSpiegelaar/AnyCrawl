import { and, eq, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { timestampKeyset, finalizeTimestampPage, type CursorKey, type PageResult } from "./Dataset.js";

type DBExecutor = any;

export type DatasetExportFormat = "jsonl" | "csv";
export type DatasetExportStatus = "queued" | "running" | "completed" | "failed";

export interface DatasetExportUpdatePatch {
    status?: DatasetExportStatus;
    itemCount?: number | null;
    fileKey?: string | null;
    error?: string | null;
    completedAt?: Date | null;
}

/**
 * Dataset export jobs (platform §11 exports / master-plan §3.2). Mirrors the
 * read/write conventions of Dataset.ts's run-listing helpers: cursor pagination
 * on (created_at DESC, uuid DESC) reusing `timestampKeyset` / `finalizeTimestampPage`
 * (exported from Dataset.ts precisely so this doesn't reimplement cursor logic),
 * and dataset-scoped reads so a wrong-dataset exportId resolves to null (the
 * controller maps that to 404, never 403 — never leak cross-owner/cross-dataset
 * existence).
 */
export class DatasetExport {
    /** Create a queued export row for a dataset. */
    static async create(
        db: DBExecutor,
        params: { datasetId: string; format: DatasetExportFormat }
    ): Promise<any> {
        const now = new Date();
        const result = await db
            .insert(schemas.datasetExports)
            .values({
                datasetId: params.datasetId,
                format: params.format,
                status: "queued",
                createdAt: now,
                updatedAt: now,
            })
            .returning();
        return result[0];
    }

    /** Dataset exports, cursor on (created_at DESC, uuid DESC) — same shape as listRuns. */
    static async list(
        db: DBExecutor,
        datasetId: string,
        opts: { limit: number; cursor?: CursorKey | null }
    ): Promise<PageResult> {
        const conditions: any[] = [eq(schemas.datasetExports.datasetId, datasetId)];
        if (opts.cursor) {
            conditions.push(
                timestampKeyset(schemas.datasetExports.createdAt, schemas.datasetExports.uuid, "desc", opts.cursor)
            );
        }
        const rows = await db
            .select()
            .from(schemas.datasetExports)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
            .orderBy(sql`${schemas.datasetExports.createdAt} DESC, ${schemas.datasetExports.uuid} DESC`)
            .limit(opts.limit + 1);

        return finalizeTimestampPage(rows, opts.limit, (r: any) => r.createdAt);
    }

    /** A single export scoped to its parent dataset. Null when not found / mismatched. */
    static async get(db: DBExecutor, datasetId: string, exportId: string): Promise<any | null> {
        const rows = await db
            .select()
            .from(schemas.datasetExports)
            .where(
                and(
                    eq(schemas.datasetExports.uuid, exportId),
                    eq(schemas.datasetExports.datasetId, datasetId)
                )
            )
            .limit(1);
        return rows[0] || null;
    }

    /** Patch mutable export fields (status / item_count / file_key / error / completed_at). */
    static async updateStatus(
        db: DBExecutor,
        exportId: string,
        patch: DatasetExportUpdatePatch
    ): Promise<void> {
        const updateData: any = { updatedAt: new Date() };
        if (patch.status !== undefined) updateData.status = patch.status;
        if (patch.itemCount !== undefined) updateData.itemCount = patch.itemCount;
        if (patch.fileKey !== undefined) updateData.fileKey = patch.fileKey;
        if (patch.error !== undefined) updateData.error = patch.error;
        if (patch.completedAt !== undefined) updateData.completedAt = patch.completedAt;

        await db
            .update(schemas.datasetExports)
            .set(updateData)
            .where(eq(schemas.datasetExports.uuid, exportId));
    }
}
