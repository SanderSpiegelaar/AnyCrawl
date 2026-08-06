import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Integration-style unit tests for the Template Run core (TemplateRun +
 * TemplateRunAccess) against a real in-memory SQLite database, using the exact
 * committed migration DDL (0014) and passing the drizzle instance in as
 * `dbOrTx`. This exercises the real query builder, the partial idempotency
 * unique index, the terminal-state guards and the /events cursor without any
 * live server — mirroring the DatasetWriter / TemplateRevision harnesses.
 *
 * The db package resolves its dialect-specific `schemas` from
 * ANYCRAWL_API_DB_TYPE at import time, so we force SQLite before importing it.
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let TemplateRun: any;
let getOwnedTemplateRun: any;
let listTemplateRunsByOwner: any;
let buildTemplateRunWhereClause: any;
let sqlite: any;
let db: any;

const TPL = "tpl-run-uuid";
const TPL_OTHER = "tpl-run-other";

const countRuns = (): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM template_runs`).get() as any).c;

const runRow = (uuid: string): any =>
    sqlite.prepare(`SELECT * FROM template_runs WHERE uuid = ?`).get(uuid) as any;

const eventCount = (): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM template_run_events`).get() as any).c;

/** Minimal create with sensible defaults; overridable per test. */
async function createRun(overrides: Record<string, unknown> = {}): Promise<any> {
    return TemplateRun.create({
        userId: "user-1",
        templateUuid: TPL,
        mode: "single",
        inputSnapshot: { url: "https://example.test" },
        normalizedInputHash: "nih-1",
        runOptions: { max_items: 10 },
        dbOrTx: db,
        ...overrides,
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    ({ TemplateRun } = await import("../model/TemplateRun.js"));
    ({ getOwnedTemplateRun, listTemplateRunsByOwner, buildTemplateRunWhereClause } = await import(
        "../model/TemplateRunAccess.js"
    ));

    sqlite = new Database(":memory:");
    // template_runs / template_run_events carry FKs to parent tables (templates,
    // template_revisions, datasets, dataset_runs, jobs, api_key) we don't build
    // in this isolated slice; disable FK enforcement.
    sqlite.pragma("foreign_keys = OFF");

    const ddl = readFileSync(
        resolve(process.cwd(), "drizzle/SQLite/0014_template_runs.sql"),
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

describe("TemplateRun.create + get", () => {
    it("inserts a queued run snapshotting revision/input/options and reads it back", async () => {
        const run = await createRun({
            templateRevisionUuid: "rev-1",
            datasetId: "ds-1",
            legacyJobUuid: "job-1",
        });
        expect(run).toBeTruthy();
        expect(run.status).toBe("queued");
        expect(run.mode).toBe("single");
        expect(run.templateUuid).toBe(TPL);
        expect(run.templateRevisionUuid).toBe("rev-1");
        expect(run.inputSnapshot).toEqual({ url: "https://example.test" });
        expect(run.normalizedInputHash).toBe("nih-1");
        expect(run.runOptions).toEqual({ max_items: 10 });
        expect(run.datasetId).toBe("ds-1");
        expect(run.legacyJobUuid).toBe("job-1");

        const got = await TemplateRun.get(run.uuid, db);
        expect(got.uuid).toBe(run.uuid);
        expect(await TemplateRun.get("does-not-exist", db)).toBeNull();
    });

    it("defaults the revision/dataset/legacy pointers to null when omitted", async () => {
        const run = await createRun();
        expect(run.templateRevisionUuid).toBeNull();
        expect(run.datasetId).toBeNull();
        expect(run.datasetRunUuid).toBeNull();
        expect(run.legacyJobUuid).toBeNull();
        expect(run.idempotencyScopeHash).toBeNull();
    });
});

describe("TemplateRun owner access (cross-owner isolation)", () => {
    it("returns the run for its owner and null for a different owner", async () => {
        const run = await createRun({ userId: "owner-a" });

        const asOwner = await getOwnedTemplateRun(db, run.uuid, { userId: "owner-a" });
        expect(asOwner?.uuid).toBe(run.uuid);

        // Different user, and an apiKey owner, must not resolve the run.
        expect(await getOwnedTemplateRun(db, run.uuid, { userId: "owner-b" })).toBeNull();
        expect(await getOwnedTemplateRun(db, run.uuid, { apiKeyId: "key-x" })).toBeNull();
    });

    it("scopes by apiKey when there is no userId", async () => {
        const run = await TemplateRun.create({
            apiKeyId: "key-1",
            templateUuid: TPL,
            mode: "single",
            dbOrTx: db,
        });
        expect((await getOwnedTemplateRun(db, run.uuid, { apiKeyId: "key-1" }))?.uuid).toBe(run.uuid);
        expect(await getOwnedTemplateRun(db, run.uuid, { apiKeyId: "key-2" })).toBeNull();
        expect(await getOwnedTemplateRun(db, run.uuid, { userId: "owner-a" })).toBeNull();
    });

    it("buildTemplateRunWhereClause is a pure predicate (no DB)", () => {
        expect(buildTemplateRunWhereClause("r1", { userId: "u1" })).toBeTruthy();
        expect(buildTemplateRunWhereClause("r1", {})).toBeTruthy();
    });
});

describe("TemplateRun.create idempotency (idempotencyScopeHash)", () => {
    it("returns the same row for a repeated scope hash and never duplicates", async () => {
        const before = countRuns();
        const first = await createRun({ userId: "idem-u", idempotencyScopeHash: "scope-hash-1" });
        const second = await createRun({ userId: "idem-u", idempotencyScopeHash: "scope-hash-1" });

        expect(second.uuid).toBe(first.uuid);
        expect(countRuns()).toBe(before + 1);
    });

    it("creates a distinct row for a different scope hash", async () => {
        const before = countRuns();
        const a = await createRun({ idempotencyScopeHash: "scope-hash-A" });
        const b = await createRun({ idempotencyScopeHash: "scope-hash-B" });
        expect(a.uuid).not.toBe(b.uuid);
        expect(countRuns()).toBe(before + 2);
    });

    it("allows many runs with a null scope hash (partial unique index)", async () => {
        const before = countRuns();
        await createRun({ idempotencyScopeHash: null });
        await createRun({ idempotencyScopeHash: null });
        expect(countRuns()).toBe(before + 2);
    });
});

describe("TemplateRun lifecycle (updateStatus / requestCancel / finalize)", () => {
    it("advances queued -> running and patches lifecycle fields", async () => {
        const run = await createRun();
        const started = new Date();
        const updated = await TemplateRun.updateStatus(
            run.uuid,
            { status: "running", startedAt: started, statistics: { pages: 1 } },
            db
        );
        expect(updated.status).toBe("running");
        expect(updated.statistics).toEqual({ pages: 1 });
        expect(runRow(run.uuid).started_at).toBeTruthy();
    });

    it("requestCancel sets cancel_requested_at + cancelling on a non-terminal run", async () => {
        const run = await createRun();
        const cancelling = await TemplateRun.requestCancel(run.uuid, db);
        expect(cancelling.status).toBe("cancelling");
        expect(runRow(run.uuid).cancel_requested_at).toBeTruthy();
    });

    it("finalize transitions to a terminal state and is not re-writable", async () => {
        const run = await createRun();
        const done = await TemplateRun.finalize(
            run.uuid,
            "completed",
            { stopReason: "completed", statistics: { items: 3 } },
            db
        );
        expect(done.status).toBe("completed");
        expect(done.stopReason).toBe("completed");
        expect(runRow(run.uuid).finished_at).toBeTruthy();

        // Terminal states are immutable: further transitions are rejected (null).
        expect(await TemplateRun.updateStatus(run.uuid, { status: "running" }, db)).toBeNull();
        expect(await TemplateRun.finalize(run.uuid, "failed", undefined, db)).toBeNull();
        // Still completed, unchanged.
        expect(runRow(run.uuid).status).toBe("completed");
    });

    it("requestCancel rejects (null) once the run is terminal", async () => {
        const run = await createRun();
        await TemplateRun.finalize(run.uuid, "failed", { errorCode: "BOOM" }, db);
        expect(await TemplateRun.requestCancel(run.uuid, db)).toBeNull();
        expect(runRow(run.uuid).status).toBe("failed");
        expect(runRow(run.uuid).cancel_requested_at).toBeNull();
    });
});

describe("TemplateRun events (appendEvent / listEvents cursor)", () => {
    it("appends events and paginates them via the (created_at, uuid) cursor", async () => {
        const run = await createRun();
        const N = 5;
        const before = eventCount();
        for (let i = 0; i < N; i++) {
            const ev = await TemplateRun.appendEvent(run.uuid, "status_changed", { seq: i }, db);
            expect(ev.eventType).toBe("status_changed");
        }
        expect(eventCount()).toBe(before + N);

        // Page through with a small limit; collect every event exactly once.
        const collected: any[] = [];
        let cursor: any = null;
        for (let guard = 0; guard < 10; guard++) {
            const page = await TemplateRun.listEvents(run.uuid, { limit: 2, cursor }, db);
            collected.push(...page.items);
            cursor = page.nextCursor;
            if (!cursor) break;
        }
        expect(collected).toHaveLength(N);
        expect(new Set(collected.map((e) => e.uuid)).size).toBe(N);
        // created_at is non-decreasing across the forward cursor.
        for (let i = 1; i < collected.length; i++) {
            expect(collected[i].createdAt.getTime()).toBeGreaterThanOrEqual(
                collected[i - 1].createdAt.getTime()
            );
        }
        // Every payload seq 0..N-1 is present (no drops / dupes).
        expect(collected.map((e) => e.payload.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it("only returns events scoped to the given run", async () => {
        const a = await createRun();
        const b = await createRun();
        await TemplateRun.appendEvent(a.uuid, "e", { r: "a" }, db);
        const page = await TemplateRun.listEvents(b.uuid, { limit: 10 }, db);
        expect(page.items).toHaveLength(0);
        expect(page.nextCursor).toBeNull();
    });
});

describe("listTemplateRunsByOwner (cursor + template filter)", () => {
    it("lists an owner's runs newest-first and filters by template", async () => {
        const owner = { userId: "list-owner" };
        // Two runs for TPL, one for a different template, all same owner.
        await TemplateRun.create({ userId: owner.userId, templateUuid: TPL, mode: "single", dbOrTx: db });
        await TemplateRun.create({ userId: owner.userId, templateUuid: TPL, mode: "single", dbOrTx: db });
        await TemplateRun.create({ userId: owner.userId, templateUuid: TPL_OTHER, mode: "single", dbOrTx: db });

        const all = await listTemplateRunsByOwner(db, owner, { limit: 50 });
        expect(all.items.length).toBeGreaterThanOrEqual(3);
        expect(all.items.every((r: any) => r.userId === owner.userId)).toBe(true);

        const onlyTpl = await listTemplateRunsByOwner(db, owner, { limit: 50, templateUuid: TPL });
        expect(onlyTpl.items.length).toBe(2);
        expect(onlyTpl.items.every((r: any) => r.templateUuid === TPL)).toBe(true);

        // A different owner sees none of these runs.
        const otherOwner = await listTemplateRunsByOwner(db, { userId: "nobody" }, { limit: 50 });
        expect(otherOwner.items.every((r: any) => r.userId !== owner.userId)).toBe(true);
    });
});
