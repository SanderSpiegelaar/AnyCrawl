import { and, eq, gt, notInArray, or, sql } from "drizzle-orm";
import { getDB, schemas } from "../db/index.js";
import type { CursorKey, PageResult } from "./Dataset.js";

type DBExecutor = any;

/** Runtime execution mode of a Template Run (platform §6 / §9.2). */
export type TemplateRunMode = "single" | "orchestrated";

/** Full Template Run lifecycle state set (platform §5). */
export type TemplateRunStatus =
    | "queued"
    | "running"
    | "partial"
    | "completed"
    | "failed"
    | "cancelling"
    | "cancelled";

/** Irreversible terminal states — never re-written once reached (§5). */
export type TemplateRunTerminalStatus = "partial" | "completed" | "failed" | "cancelled";

/** The four terminal states; a run in any of these is immutable. */
export const TEMPLATE_RUN_TERMINAL_STATUSES: readonly TemplateRunStatus[] = [
    "completed",
    "partial",
    "failed",
    "cancelled",
];

export interface CreateTemplateRunParams {
    apiKeyId?: string | null;
    userId?: string | null;
    templateUuid: string;
    /** Frozen revision this run reproduces; null when a legacy adapter runs current config. */
    templateRevisionUuid?: string | null;
    mode: TemplateRunMode;
    /** Initial status; defaults to `queued`. */
    status?: TemplateRunStatus;
    /** Owner+Template+Idempotency-Key hash (§9.2 rule 2); enables idempotent create. */
    idempotencyScopeHash?: string | null;
    inputSnapshot?: Record<string, unknown> | null;
    normalizedInputHash?: string | null;
    runOptions?: Record<string, unknown> | null;
    datasetId?: string | null;
    datasetRunUuid?: string | null;
    legacyJobUuid?: string | null;
    statistics?: Record<string, unknown> | null;
    /** Reuse an existing transaction/executor; otherwise a fresh getDB() connection. */
    dbOrTx?: DBExecutor;
    /** Injected clock for deterministic tests. */
    now?: Date;
}

export interface UpdateTemplateRunStatusPatch {
    status?: TemplateRunStatus;
    stopReason?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    statistics?: Record<string, unknown> | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
}

export interface FinalizeTemplateRunExtras {
    stopReason?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    statistics?: Record<string, unknown> | null;
    startedAt?: Date | null;
    /** Terminal timestamp; defaults to now. */
    finishedAt?: Date | null;
}

/**
 * Unified async Template Run record (platform §9.2). One row tracks a single
 * Template execution — legacy or orchestrated — through the lifecycle state
 * machine (§5): queued→running→{completed|partial|failed} and
 * cancelling→cancelled. Terminal states are immutable, so `updateStatus`,
 * `requestCancel` and `finalize` all guard on the current status being
 * non-terminal (an atomic `WHERE status NOT IN (terminal)`), which makes
 * duplicate BullMQ retries and double-finalize safe.
 *
 * Mirrors the static-class / optional-`dbOrTx` style of TemplateRevision so the
 * write paths are testable against an injected drizzle instance and can run
 * inside a caller's transaction.
 */
export class TemplateRun {
    /**
     * Insert a run (default `queued`), snapshotting the revision, input, run
     * options and dataset destination. When `idempotencyScopeHash` is provided
     * the insert uses onConflictDoNothing against the partial unique index
     * `uq_template_run_idempotency` and re-selects the canonical row, so a repeat
     * request with the same scope hash returns the original run instead of a
     * duplicate (§9.2 rule 2).
     *
     * The conflict clause is left untargeted (`ON CONFLICT DO NOTHING`) rather
     * than naming the partial index: it is valid and identical in both dialects,
     * and it still honors the partial `uq_template_run_idempotency` — null-hash
     * rows are outside the index so they never conflict, while a duplicate
     * non-null hash is a no-op. (Naming a partial target trips a drizzle SQLite
     * emit bug that places the target WHERE after DO NOTHING.)
     */
    static async create(params: CreateTemplateRunParams): Promise<any> {
        const db = params.dbOrTx ?? (await getDB());
        const now = params.now ?? new Date();

        const values = {
            apiKey: params.apiKeyId ?? null,
            userId: params.userId ?? null,
            templateUuid: params.templateUuid,
            templateRevisionUuid: params.templateRevisionUuid ?? null,
            mode: params.mode,
            status: params.status ?? "queued",
            idempotencyScopeHash: params.idempotencyScopeHash ?? null,
            inputSnapshot: params.inputSnapshot ?? null,
            normalizedInputHash: params.normalizedInputHash ?? null,
            runOptions: params.runOptions ?? null,
            datasetId: params.datasetId ?? null,
            datasetRunUuid: params.datasetRunUuid ?? null,
            legacyJobUuid: params.legacyJobUuid ?? null,
            statistics: params.statistics ?? null,
            createdAt: now,
            updatedAt: now,
        };

        if (params.idempotencyScopeHash) {
            const [inserted] = await db
                .insert(schemas.templateRuns)
                .values(values)
                .onConflictDoNothing()
                .returning();

            if (inserted) return inserted;

            // Idempotent hit (or lost the insert race) — re-select the canonical run.
            const [existing] = await db
                .select()
                .from(schemas.templateRuns)
                .where(
                    and(
                        eq(schemas.templateRuns.templateUuid, params.templateUuid),
                        eq(schemas.templateRuns.idempotencyScopeHash, params.idempotencyScopeHash)
                    )
                )
                .limit(1);
            return existing ?? null;
        }

        const [row] = await db.insert(schemas.templateRuns).values(values).returning();
        return row;
    }

    /** Fetch a single run by its uuid (ownership-agnostic; see TemplateRunAccess). */
    static async get(uuid: string, dbOrTx?: DBExecutor): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const rows = await db
            .select()
            .from(schemas.templateRuns)
            .where(eq(schemas.templateRuns.uuid, uuid))
            .limit(1);
        return rows[0] ?? null;
    }

    /**
     * Patch mutable lifecycle fields. Only applies while the run is still
     * non-terminal so a completed/failed/cancelled run is never re-written
     * (§5 rule 3). Returns the updated row, or null when the run is missing or
     * already terminal.
     */
    static async updateStatus(
        uuid: string,
        patch: UpdateTemplateRunStatusPatch,
        dbOrTx?: DBExecutor
    ): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const updateData: any = { updatedAt: new Date() };
        if (patch.status !== undefined) updateData.status = patch.status;
        if (patch.stopReason !== undefined) updateData.stopReason = patch.stopReason;
        if (patch.errorCode !== undefined) updateData.errorCode = patch.errorCode;
        if (patch.errorMessage !== undefined) updateData.errorMessage = patch.errorMessage;
        if (patch.statistics !== undefined) updateData.statistics = patch.statistics;
        if (patch.startedAt !== undefined) updateData.startedAt = patch.startedAt;
        if (patch.finishedAt !== undefined) updateData.finishedAt = patch.finishedAt;

        const result = await db
            .update(schemas.templateRuns)
            .set(updateData)
            .where(
                and(
                    eq(schemas.templateRuns.uuid, uuid),
                    notInArray(schemas.templateRuns.status, TEMPLATE_RUN_TERMINAL_STATUSES as string[])
                )
            )
            .returning();
        return result[0] ?? null;
    }

    /**
     * Record a cancel request: set `cancel_requested_at` and move the run to
     * `cancelling`. Cancel only applies to a non-terminal run; a terminal run is
     * rejected (returns null) so an already finished run is never reopened. The
     * worker later drives the run to the `cancelled` terminal state via
     * `finalize`.
     */
    static async requestCancel(uuid: string, dbOrTx?: DBExecutor): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const now = new Date();
        const result = await db
            .update(schemas.templateRuns)
            .set({ cancelRequestedAt: now, status: "cancelling", updatedAt: now })
            .where(
                and(
                    eq(schemas.templateRuns.uuid, uuid),
                    notInArray(schemas.templateRuns.status, TEMPLATE_RUN_TERMINAL_STATUSES as string[])
                )
            )
            .returning();
        return result[0] ?? null;
    }

    /**
     * Atomically transition a still-non-terminal run to a terminal state
     * (completed/partial/failed/cancelled) with its stop reason / error /
     * statistics and a `finished_at`. Idempotent against double-finalize: a run
     * already terminal matches nothing and returns null.
     */
    static async finalize(
        uuid: string,
        terminalStatus: TemplateRunTerminalStatus,
        extras?: FinalizeTemplateRunExtras,
        dbOrTx?: DBExecutor
    ): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const now = new Date();
        const updateData: any = {
            status: terminalStatus,
            finishedAt: extras?.finishedAt ?? now,
            updatedAt: now,
        };
        if (extras?.stopReason !== undefined) updateData.stopReason = extras.stopReason;
        if (extras?.errorCode !== undefined) updateData.errorCode = extras.errorCode;
        if (extras?.errorMessage !== undefined) updateData.errorMessage = extras.errorMessage;
        if (extras?.statistics !== undefined) updateData.statistics = extras.statistics;
        if (extras?.startedAt !== undefined) updateData.startedAt = extras.startedAt;

        const result = await db
            .update(schemas.templateRuns)
            .set(updateData)
            .where(
                and(
                    eq(schemas.templateRuns.uuid, uuid),
                    notInArray(schemas.templateRuns.status, TEMPLATE_RUN_TERMINAL_STATUSES as string[])
                )
            )
            .returning();
        return result[0] ?? null;
    }

    /**
     * Append an audit event to a run's `/events` feed (§11.8). Events are an
     * append-only audit record — not the source of truth for live status. Accepts
     * an optional `dbOrTx` so the event can be written in the same transaction as
     * the status change it records.
     */
    static async appendEvent(
        runId: string,
        eventType: string,
        payload?: Record<string, unknown> | null,
        dbOrTx?: DBExecutor
    ): Promise<any> {
        const db = dbOrTx ?? (await getDB());
        const [row] = await db
            .insert(schemas.templateRunEvents)
            .values({
                templateRunUuid: runId,
                eventType,
                payload: payload ?? null,
                createdAt: new Date(),
            })
            .returning();
        return row;
    }

    /**
     * List a run's events in chronological (forward) order for cursor polling,
     * keyset on (created_at ASC, uuid ASC) — backed by `ix_template_run_event_cursor`.
     * A `/events` poller passes back the previous `nextCursor` to fetch only
     * events newer than the last one seen.
     */
    static async listEvents(
        runId: string,
        opts: { limit: number; cursor?: CursorKey | null },
        dbOrTx?: DBExecutor
    ): Promise<PageResult> {
        const db = dbOrTx ?? (await getDB());
        const conditions: any[] = [eq(schemas.templateRunEvents.templateRunUuid, runId)];
        if (opts.cursor) {
            // Forward keyset on (created_at, uuid). Use drizzle operators (not raw
            // sql) so the Date is encoded through the column's timestamp codec.
            const d = new Date(Number(opts.cursor.v));
            conditions.push(
                or(
                    gt(schemas.templateRunEvents.createdAt, d),
                    and(
                        eq(schemas.templateRunEvents.createdAt, d),
                        gt(schemas.templateRunEvents.uuid, opts.cursor.id)
                    )
                )
            );
        }
        const rows = await db
            .select()
            .from(schemas.templateRunEvents)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
            .orderBy(sql`${schemas.templateRunEvents.createdAt} ASC, ${schemas.templateRunEvents.uuid} ASC`)
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
}
