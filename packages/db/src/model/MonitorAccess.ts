import type { OwnerContext } from "@anycrawl/libs";
import { eq, sql, getTableColumns } from "drizzle-orm";
import { schemas } from "../db/index.js";

type DBExecutor = any;

/**
 * Monitor columns plus the schedule/execution-timing fields that live on the
 * backing scheduled_tasks row (cron, timezone, next/last execution). The monitor
 * detail UI needs these, and they only exist on the task, so every monitor read
 * left-joins the task and merges them in.
 */
function monitorSelection() {
    return {
        ...getTableColumns(schemas.monitors),
        cronExpression: schemas.scheduledTasks.cronExpression,
        timezone: schemas.scheduledTasks.timezone,
        nextExecutionAt: schemas.scheduledTasks.nextExecutionAt,
        lastExecutionAt: schemas.scheduledTasks.lastExecutionAt,
        isPaused: schemas.scheduledTasks.isPaused,
    };
}

export function buildMonitorWhereClause(monitorId: string, owner: OwnerContext): any {
    if (owner.userId) {
        return sql`${schemas.monitors.uuid} = ${monitorId} AND ${schemas.monitors.userId} = ${owner.userId}`;
    }

    if (owner.apiKeyId) {
        return sql`${schemas.monitors.uuid} = ${monitorId} AND ${schemas.monitors.apiKey} = ${owner.apiKeyId}`;
    }

    return sql`${schemas.monitors.uuid} = ${monitorId}`;
}

export async function getOwnedMonitor(db: DBExecutor, monitorId: string, owner: OwnerContext): Promise<any | null> {
    const whereClause = buildMonitorWhereClause(monitorId, owner);
    const monitors = await db
        .select(monitorSelection())
        .from(schemas.monitors)
        .leftJoin(
            schemas.scheduledTasks,
            eq(schemas.monitors.scheduledTaskUuid, schemas.scheduledTasks.uuid)
        )
        .where(whereClause)
        .limit(1);

    return monitors[0] || null;
}

export async function listMonitorsByOwner(db: DBExecutor, owner: OwnerContext): Promise<any[]> {
    const query = db
        .select(monitorSelection())
        .from(schemas.monitors)
        .leftJoin(
            schemas.scheduledTasks,
            eq(schemas.monitors.scheduledTaskUuid, schemas.scheduledTasks.uuid)
        );

    if (owner.userId) {
        return await query
            .where(eq(schemas.monitors.userId, owner.userId))
            .orderBy(sql`${schemas.monitors.createdAt} DESC`);
    }

    if (owner.apiKeyId) {
        return await query
            .where(eq(schemas.monitors.apiKey, owner.apiKeyId))
            .orderBy(sql`${schemas.monitors.createdAt} DESC`);
    }

    return await query.orderBy(sql`${schemas.monitors.createdAt} DESC`);
}

/**
 * Find the monitor whose underlying scheduled task matches the given uuid.
 * Used by the post-processing hook to detect monitor-managed executions.
 */
export async function getMonitorByScheduledTask(db: DBExecutor, scheduledTaskUuid: string): Promise<any | null> {
    const monitors = await db
        .select()
        .from(schemas.monitors)
        .where(eq(schemas.monitors.scheduledTaskUuid, scheduledTaskUuid))
        .limit(1);

    return monitors[0] || null;
}

/**
 * Return the most recent snapshot for a (monitor, url) that predates the current run.
 * Ordered by capturedAt desc; offset 1 skips the just-written snapshot when called after insert,
 * so callers should call this BEFORE inserting the new snapshot (offset 0).
 */
export async function getLatestSnapshot(db: DBExecutor, monitorUuid: string, url: string): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.monitorSnapshots)
        .where(
            // 'error' snapshots record failed checks for visibility only — they carry
            // no content and must never serve as the diff baseline, or the next
            // successful check would false-alert against an empty hash.
            sql`${schemas.monitorSnapshots.monitorUuid} = ${monitorUuid} AND ${schemas.monitorSnapshots.url} = ${url} AND ${schemas.monitorSnapshots.status} != 'error'`
        )
        .orderBy(sql`${schemas.monitorSnapshots.capturedAt} DESC`)
        .limit(1);

    return rows[0] || null;
}

/**
 * List rows deliberately exclude the heavy columns (`content` up to 256KB,
 * `extracted`): the dashboard polls this list every few seconds with limit 50,
 * which shipped ~12.8MB per poll when full rows were returned. Full payloads
 * are served per-snapshot via getSnapshotForMonitor.
 */
export async function listSnapshotsByMonitor(
    db: DBExecutor,
    monitorUuid: string,
    skip: number,
    limit: number
): Promise<any[]> {
    return await db
        .select({
            uuid: schemas.monitorSnapshots.uuid,
            monitorUuid: schemas.monitorSnapshots.monitorUuid,
            taskExecutionUuid: schemas.monitorSnapshots.taskExecutionUuid,
            url: schemas.monitorSnapshots.url,
            contentHash: schemas.monitorSnapshots.contentHash,
            status: schemas.monitorSnapshots.status,
            capturedAt: schemas.monitorSnapshots.capturedAt,
        })
        .from(schemas.monitorSnapshots)
        .where(eq(schemas.monitorSnapshots.monitorUuid, monitorUuid))
        .orderBy(sql`${schemas.monitorSnapshots.capturedAt} DESC`)
        .limit(limit)
        .offset(skip);
}

/**
 * Fetch one snapshot INCLUDING content/extracted, scoped to the monitor so a
 * snapshot uuid from another monitor (or another owner's monitor) 404s at the
 * controller instead of leaking content.
 */
export async function getSnapshotForMonitor(
    db: DBExecutor,
    monitorUuid: string,
    snapshotUuid: string
): Promise<any | null> {
    const rows = await db
        .select()
        .from(schemas.monitorSnapshots)
        .where(
            sql`${schemas.monitorSnapshots.uuid} = ${snapshotUuid} AND ${schemas.monitorSnapshots.monitorUuid} = ${monitorUuid}`
        )
        .limit(1);

    return rows[0] || null;
}

export async function listChangesByMonitor(
    db: DBExecutor,
    monitorUuid: string,
    skip: number,
    limit: number
): Promise<any[]> {
    return await db
        .select()
        .from(schemas.monitorChanges)
        .where(eq(schemas.monitorChanges.monitorUuid, monitorUuid))
        .orderBy(sql`${schemas.monitorChanges.createdAt} DESC`)
        .limit(limit)
        .offset(skip);
}
