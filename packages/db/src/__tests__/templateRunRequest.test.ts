import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

/**
 * Integration-style unit tests for the Template Run request ledger
 * (TemplateRunRequest) against a real in-memory SQLite database, using the exact
 * committed migration DDL (0015) and passing the drizzle instance in as
 * `dbOrTx`. Exercises the real query builder, the unique (template_run_id,
 * request_key) dedup index, the status/cursor list path and the atomic claim —
 * mirroring the TemplateRun harness.
 *
 * The db package resolves its dialect-specific `schemas` from
 * ANYCRAWL_API_DB_TYPE at import time, so we force SQLite before importing it.
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let TemplateRunRequest: any;
let sqlite: any;
let db: any;

const requestCount = (runId: string): number =>
    (sqlite
        .prepare(`SELECT COUNT(*) AS c FROM template_run_requests WHERE template_run_id = ?`)
        .get(runId) as any).c;

const row = (uuid: string): any =>
    sqlite.prepare(`SELECT * FROM template_run_requests WHERE uuid = ?`).get(uuid) as any;

/** Minimal enqueue with sensible defaults; overridable per test. */
async function enqueue(overrides: Record<string, unknown> = {}): Promise<any> {
    return TemplateRunRequest.enqueue({
        templateRunUuid: "run-default",
        requestKey: "rk-default",
        requestType: "page",
        normalizedUrl: "https://example.test/p/1",
        dbOrTx: db,
        ...overrides,
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    ({ TemplateRunRequest } = await import("../model/TemplateRunRequest.js"));

    sqlite = new Database(":memory:");
    // template_run_requests carries an FK to template_runs, which we do not build
    // in this isolated slice; disable FK enforcement.
    sqlite.pragma("foreign_keys = OFF");

    const ddl = readFileSync(
        resolve(process.cwd(), "drizzle/SQLite/0015_template_run_requests.sql"),
        "utf8"
    );
    for (const raw of ddl.split("--> statement-breakpoint")) {
        const stmt = raw.trim();
        if (stmt.length > 0) sqlite.exec(stmt);
    }

    db = drizzle(sqlite, { schema });
});

afterAll(() => {
    sqlite?.close();
});

describe("TemplateRunRequest.enqueue + get", () => {
    it("inserts a queued request snapshotting its fields and reads it back", async () => {
        const run = randomUUID();
        const req = await enqueue({
            templateRunUuid: run,
            requestKey: "seed:0",
            requestType: "seed",
            seedKey: "search-a",
            seedIndex: 0,
            normalizedUrl: "https://example.test/search?q=a",
            pageIndex: 0,
        });
        expect(req).toBeTruthy();
        expect(req.status).toBe("queued");
        expect(req.requestType).toBe("seed");
        expect(req.templateRunUuid).toBe(run);
        expect(req.requestKey).toBe("seed:0");
        expect(req.seedKey).toBe("search-a");
        expect(req.seedIndex).toBe(0);
        expect(req.pageIndex).toBe(0);
        expect(req.attempts).toBe(0);
        expect(req.queuedAt).toBeTruthy();

        const got = await TemplateRunRequest.get(req.uuid, db);
        expect(got.uuid).toBe(req.uuid);
        expect(await TemplateRunRequest.get("does-not-exist", db)).toBeNull();
    });

    it("defaults optional pointers/columns to null when omitted", async () => {
        const req = await enqueue({ templateRunUuid: randomUUID(), requestKey: "rk-nulls" });
        expect(req.seedKey).toBeNull();
        expect(req.seedIndex).toBeNull();
        expect(req.parentRequestUuid).toBeNull();
        expect(req.pageIndex).toBeNull();
        expect(req.queueJobId).toBeNull();
        expect(req.lastError).toBeNull();
        expect(req.startedAt).toBeNull();
        expect(req.finishedAt).toBeNull();
    });
});

describe("TemplateRunRequest.enqueue idempotency (unique request_key per run)", () => {
    it("returns the same row for a repeated (run, request_key) and never duplicates", async () => {
        const run = randomUUID();
        const first = await enqueue({ templateRunUuid: run, requestKey: "dup-key", queueJobId: "job-1" });
        const second = await enqueue({ templateRunUuid: run, requestKey: "dup-key", queueJobId: "job-2" });

        expect(second.uuid).toBe(first.uuid);
        // The re-select returns the ORIGINAL row (its first queueJobId), not the retry's.
        expect(second.queueJobId).toBe("job-1");
        expect(requestCount(run)).toBe(1);
    });

    it("keeps the same request_key distinct across different runs", async () => {
        const runA = randomUUID();
        const runB = randomUUID();
        const a = await enqueue({ templateRunUuid: runA, requestKey: "same-key" });
        const b = await enqueue({ templateRunUuid: runB, requestKey: "same-key" });
        expect(a.uuid).not.toBe(b.uuid);
        expect(requestCount(runA)).toBe(1);
        expect(requestCount(runB)).toBe(1);
    });

    it("creates distinct rows for different request_keys in one run", async () => {
        const run = randomUUID();
        await enqueue({ templateRunUuid: run, requestKey: "k1" });
        await enqueue({ templateRunUuid: run, requestKey: "k2" });
        expect(requestCount(run)).toBe(2);
    });
});

describe("TemplateRunRequest.listByRun (status filter + cursor)", () => {
    it("lists a run's requests, filters by status, and paginates via the cursor", async () => {
        const run = randomUUID();
        const N = 5;
        for (let i = 0; i < N; i++) {
            // Distinct, increasing created_at so the forward cursor order is stable.
            await enqueue({
                templateRunUuid: run,
                requestKey: `page:${i}`,
                pageIndex: i,
                now: new Date(1_700_000_000_000 + i * 1000),
                status: i < 2 ? "completed" : "queued",
            });
        }

        // Status filter: 3 queued, 2 completed.
        const queued = await TemplateRunRequest.listByRun(run, { status: "queued", limit: 50 }, db);
        expect(queued.items).toHaveLength(3);
        expect(queued.items.every((r: any) => r.status === "queued")).toBe(true);

        const completed = await TemplateRunRequest.listByRun(run, { status: "completed", limit: 50 }, db);
        expect(completed.items).toHaveLength(2);

        // Cursor pagination across the whole run, small page size; each row once.
        const collected: any[] = [];
        let cursor: any = null;
        for (let guard = 0; guard < 10; guard++) {
            const page = await TemplateRunRequest.listByRun(run, { limit: 2, cursor }, db);
            collected.push(...page.items);
            cursor = page.nextCursor;
            if (!cursor) break;
        }
        expect(collected).toHaveLength(N);
        expect(new Set(collected.map((r) => r.uuid)).size).toBe(N);
        // created_at is non-decreasing across the forward cursor.
        for (let i = 1; i < collected.length; i++) {
            expect(collected[i].createdAt.getTime()).toBeGreaterThanOrEqual(
                collected[i - 1].createdAt.getTime()
            );
        }
    });

    it("only returns requests scoped to the given run", async () => {
        const run = randomUUID();
        await enqueue({ templateRunUuid: randomUUID(), requestKey: "elsewhere" });
        const page = await TemplateRunRequest.listByRun(run, { limit: 10 }, db);
        expect(page.items).toHaveLength(0);
        expect(page.nextCursor).toBeNull();
    });
});

describe("TemplateRunRequest.updateStatus", () => {
    it("patches status/attempts/queueJobId/lastError/timestamps", async () => {
        const run = randomUUID();
        const req = await enqueue({ templateRunUuid: run, requestKey: "u1" });
        const finished = new Date(1_700_000_500_000);
        const updated = await TemplateRunRequest.updateStatus(
            req.uuid,
            {
                status: "failed",
                attempts: 2,
                queueJobId: "bull-42",
                lastError: "timeout",
                finishedAt: finished,
            },
            db
        );
        expect(updated.status).toBe("failed");
        expect(updated.attempts).toBe(2);
        expect(updated.queueJobId).toBe("bull-42");
        expect(updated.lastError).toBe("timeout");
        expect(row(req.uuid).finished_at).toBeTruthy();

        // No terminal guard: a retry may move failed -> queued under the same key.
        const requeued = await TemplateRunRequest.updateStatus(req.uuid, { status: "queued" }, db);
        expect(requeued.status).toBe("queued");

        // Missing uuid -> null.
        expect(await TemplateRunRequest.updateStatus("nope", { status: "queued" }, db)).toBeNull();
    });
});

describe("TemplateRunRequest.claimNext", () => {
    it("claims the oldest queued request, moves it to running and bumps attempts", async () => {
        const run = randomUUID();
        await enqueue({ templateRunUuid: run, requestKey: "c1", now: new Date(1_700_000_000_000) });
        await enqueue({ templateRunUuid: run, requestKey: "c2", now: new Date(1_700_000_001_000) });

        const first = await TemplateRunRequest.claimNext(run, {}, db);
        expect(first.requestKey).toBe("c1");
        expect(first.status).toBe("running");
        expect(first.attempts).toBe(1);
        expect(first.startedAt).toBeTruthy();

        const second = await TemplateRunRequest.claimNext(run, {}, db);
        expect(second.requestKey).toBe("c2");

        // Nothing queued left -> null.
        expect(await TemplateRunRequest.claimNext(run, {}, db)).toBeNull();
    });
});

describe("TemplateRunRequest.countByStatus", () => {
    it("returns per-status counts for a run, omitting empty statuses", async () => {
        const run = randomUUID();
        await enqueue({ templateRunUuid: run, requestKey: "s1", status: "queued" });
        await enqueue({ templateRunUuid: run, requestKey: "s2", status: "queued" });
        await enqueue({ templateRunUuid: run, requestKey: "s3", status: "running" });
        await enqueue({ templateRunUuid: run, requestKey: "s4", status: "completed" });
        await enqueue({ templateRunUuid: run, requestKey: "s5", status: "completed" });
        await enqueue({ templateRunUuid: run, requestKey: "s6", status: "completed" });

        const counts = await TemplateRunRequest.countByStatus(run, db);
        expect(counts).toEqual({ queued: 2, running: 1, completed: 3 });
        expect(counts.failed).toBeUndefined();

        // A run with no requests returns an empty map.
        expect(await TemplateRunRequest.countByStatus(randomUUID(), db)).toEqual({});
    });
});
