import { and, eq, gt, or, sql } from "drizzle-orm";
import { getDB, schemas } from "../db/index.js";
import type { CursorKey, PageResult } from "./Dataset.js";

type DBExecutor = any;

/** Kind of logical request an orchestrated Run dispatches (platform §9.3). */
export type TemplateRunRequestType = "page" | "detail" | "seed";

/** Request ledger lifecycle states (platform §9.3). Unlike a Run, a request is
 * not immutable at a terminal state: a BullMQ retry may re-queue a failed
 * request under the same `request_key`, so there is no terminal write guard. */
export type TemplateRunRequestStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "skipped";

export interface EnqueueTemplateRunRequestParams {
    /** Parent Run this request belongs to (FK → template_runs.uuid). */
    templateRunUuid: string;
    /** Stable dedup key derived from request type + seed + normalized URL (§9.3). */
    requestKey: string;
    requestType: TemplateRunRequestType;
    seedKey?: string | null;
    seedIndex?: number | null;
    /** Originating request (plain reference, not an FK — see schema note). */
    parentRequestUuid?: string | null;
    normalizedUrl: string;
    pageIndex?: number | null;
    /** Initial status; defaults to `queued`. */
    status?: TemplateRunRequestStatus;
    /** Initial attempt count; defaults to 0. */
    attempts?: number;
    queueJobId?: string | null;
    /** When the request entered the queue; defaults to now. */
    queuedAt?: Date | null;
    /** Reuse an existing transaction/executor; otherwise a fresh getDB() connection. */
    dbOrTx?: DBExecutor;
    /** Injected clock for deterministic tests. */
    now?: Date;
}

export interface UpdateTemplateRunRequestPatch {
    status?: TemplateRunRequestStatus;
    attempts?: number;
    queueJobId?: string | null;
    lastError?: string | null;
    queuedAt?: Date | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
}

export interface ClaimNextOptions {
    /** Status the claimed request is moved to; defaults to `running`. */
    toStatus?: TemplateRunRequestStatus;
    /** Timestamp written to `started_at`; defaults to now. */
    startedAt?: Date;
}

/**
 * Orchestrated Run request ledger (platform §9.3). One row per logical request
 * (seed / page / detail) that an orchestrated Run dispatches. The database holds
 * business state — visited / loop-detection and resume — while BullMQ holds
 * dispatch state; the two align through the stable `queue_job_id`.
 *
 * `enqueue` is idempotent against `uq_template_run_request` (template_run_id,
 * request_key): a BullMQ retry that re-materializes the same logical request is
 * a no-op that returns the original row, so a request is never dispatched twice.
 *
 * Mirrors the static-class / optional-`dbOrTx` style of TemplateRun so write
 * paths are testable against an injected drizzle instance and can run inside a
 * caller's transaction.
 */
export class TemplateRunRequest {
    /**
     * Idempotently enqueue a request. The insert uses onConflictDoNothing
     * against the unique (template_run_id, request_key) index and re-selects the
     * canonical row, so a repeated enqueue for the same logical request returns
     * the original row instead of creating a duplicate (§9.3). The conflict
     * clause is left untargeted (`ON CONFLICT DO NOTHING`) — valid and identical
     * in both dialects and covered by the sole unique index on the table.
     */
    static async enqueue(params: EnqueueTemplateRunRequestParams): Promise<any> {
        const db = params.dbOrTx ?? (await getDB());
        const now = params.now ?? new Date();
        const status = params.status ?? "queued";

        const values = {
            templateRunUuid: params.templateRunUuid,
            requestKey: params.requestKey,
            requestType: params.requestType,
            seedKey: params.seedKey ?? null,
            seedIndex: params.seedIndex ?? null,
            parentRequestUuid: params.parentRequestUuid ?? null,
            normalizedUrl: params.normalizedUrl,
            pageIndex: params.pageIndex ?? null,
            status,
            attempts: params.attempts ?? 0,
            queueJobId: params.queueJobId ?? null,
            lastError: null,
            queuedAt: params.queuedAt ?? now,
            startedAt: null,
            finishedAt: null,
            createdAt: now,
        };

        const [inserted] = await db
            .insert(schemas.templateRunRequests)
            .values(values)
            .onConflictDoNothing()
            .returning();

        if (inserted) return inserted;

        // Idempotent hit (or lost the insert race) — re-select the canonical row.
        const [existing] = await db
            .select()
            .from(schemas.templateRunRequests)
            .where(
                and(
                    eq(schemas.templateRunRequests.templateRunUuid, params.templateRunUuid),
                    eq(schemas.templateRunRequests.requestKey, params.requestKey)
                )
            )
            .limit(1);
        return existing ?? null;
    }

    /** Fetch a single request by its uuid. */
    static async get(uuid: string, dbOrTx?: DBExecutor): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const rows = await db
            .select()
            .from(schemas.templateRunRequests)
            .where(eq(schemas.templateRunRequests.uuid, uuid))
            .limit(1);
        return rows[0] ?? null;
    }

    /**
     * List a run's requests in chronological (forward) order for cursor
     * pagination, keyset on (created_at ASC, uuid ASC). Optionally narrowed to a
     * single status; the (template_run_id, status) index covers that predicate.
     */
    static async listByRun(
        templateRunUuid: string,
        opts: { status?: TemplateRunRequestStatus; limit: number; cursor?: CursorKey | null },
        dbOrTx?: DBExecutor
    ): Promise<PageResult> {
        const db = dbOrTx ?? (await getDB());
        const conditions: any[] = [
            eq(schemas.templateRunRequests.templateRunUuid, templateRunUuid),
        ];
        if (opts.status) {
            conditions.push(eq(schemas.templateRunRequests.status, opts.status));
        }
        if (opts.cursor) {
            // Forward keyset on (created_at, uuid). Use drizzle operators (not raw
            // sql) so the Date is encoded through the column's timestamp codec.
            const d = new Date(Number(opts.cursor.v));
            conditions.push(
                or(
                    gt(schemas.templateRunRequests.createdAt, d),
                    and(
                        eq(schemas.templateRunRequests.createdAt, d),
                        gt(schemas.templateRunRequests.uuid, opts.cursor.id)
                    )
                )
            );
        }

        const rows = await db
            .select()
            .from(schemas.templateRunRequests)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
            .orderBy(
                sql`${schemas.templateRunRequests.createdAt} ASC, ${schemas.templateRunRequests.uuid} ASC`
            )
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
     * Patch mutable request fields (status / attempts / queue_job_id /
     * last_error / timestamps). There is no terminal-state guard: a BullMQ retry
     * may legitimately move a `failed` request back to `queued` under the same
     * `request_key`. Returns the updated row, or null when the uuid is missing.
     */
    static async updateStatus(
        uuid: string,
        patch: UpdateTemplateRunRequestPatch,
        dbOrTx?: DBExecutor
    ): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const updateData: any = {};
        if (patch.status !== undefined) updateData.status = patch.status;
        if (patch.attempts !== undefined) updateData.attempts = patch.attempts;
        if (patch.queueJobId !== undefined) updateData.queueJobId = patch.queueJobId;
        if (patch.lastError !== undefined) updateData.lastError = patch.lastError;
        if (patch.queuedAt !== undefined) updateData.queuedAt = patch.queuedAt;
        if (patch.startedAt !== undefined) updateData.startedAt = patch.startedAt;
        if (patch.finishedAt !== undefined) updateData.finishedAt = patch.finishedAt;

        // Nothing to patch → return the current row unchanged.
        if (Object.keys(updateData).length === 0) {
            return TemplateRunRequest.get(uuid, db);
        }

        const result = await db
            .update(schemas.templateRunRequests)
            .set(updateData)
            .where(eq(schemas.templateRunRequests.uuid, uuid))
            .returning();
        return result[0] ?? null;
    }

    /**
     * Atomically claim the oldest `queued` request of a run for the worker:
     * moves it to `running` (or `toStatus`), bumps `attempts`, and stamps
     * `started_at`. The claim is a guarded UPDATE (`WHERE uuid = ? AND status =
     * 'queued'`) so two concurrent workers can never claim the same row; on a
     * lost race it retries with the next candidate. Returns the claimed row, or
     * null when the run has no queued requests left.
     */
    static async claimNext(
        templateRunUuid: string,
        opts: ClaimNextOptions = {},
        dbOrTx?: DBExecutor
    ): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const toStatus = opts.toStatus ?? "running";

        // Bounded retry: each iteration picks the current oldest queued candidate
        // and tries to win it via a status-guarded update. A lost race (someone
        // else claimed it) falls through to the next candidate.
        for (let guard = 0; guard < 25; guard++) {
            const [candidate] = await db
                .select({ uuid: schemas.templateRunRequests.uuid })
                .from(schemas.templateRunRequests)
                .where(
                    and(
                        eq(schemas.templateRunRequests.templateRunUuid, templateRunUuid),
                        eq(schemas.templateRunRequests.status, "queued")
                    )
                )
                .orderBy(
                    sql`${schemas.templateRunRequests.createdAt} ASC, ${schemas.templateRunRequests.uuid} ASC`
                )
                .limit(1);

            if (!candidate) return null;

            const result = await db
                .update(schemas.templateRunRequests)
                .set({
                    status: toStatus,
                    attempts: sql`${schemas.templateRunRequests.attempts} + 1`,
                    startedAt: opts.startedAt ?? new Date(),
                })
                .where(
                    and(
                        eq(schemas.templateRunRequests.uuid, candidate.uuid),
                        eq(schemas.templateRunRequests.status, "queued")
                    )
                )
                .returning();

            if (result[0]) return result[0];
            // Lost the race for this candidate; try the next one.
        }
        return null;
    }

    /**
     * Count a run's requests grouped by status, e.g. `{ queued: 3, running: 1,
     * completed: 10 }`. Backed by `ix_template_run_request_status`. Statuses with
     * no rows are simply absent from the map. Used by the worker to decide when a
     * run has drained (no queued/running left) and to build run statistics.
     */
    static async countByStatus(
        templateRunUuid: string,
        dbOrTx?: DBExecutor
    ): Promise<Record<string, number>> {
        const db = dbOrTx ?? (await getDB());
        const rows = await db
            .select({
                status: schemas.templateRunRequests.status,
                count: sql<number>`count(*)`,
            })
            .from(schemas.templateRunRequests)
            .where(eq(schemas.templateRunRequests.templateRunUuid, templateRunUuid))
            .groupBy(schemas.templateRunRequests.status);

        const out: Record<string, number> = {};
        for (const r of rows) {
            out[r.status as string] = Number(r.count);
        }
        return out;
    }
}
