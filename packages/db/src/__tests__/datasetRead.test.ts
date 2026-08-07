import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for the dataset-read `this`-binding bug (live integration bug #1).
 *
 * `Dataset.getItems` / `listRuns` / `listChanges` / `listByOwner` / `listRunWarnings`
 * are re-exported *bare* from `@anycrawl/db` (e.g. `export const getDatasetItems =
 * Dataset.getItems`). Each ends by delegating to the private static helper
 * `finalizeTimestamp` to trim the limit+1 fetch and derive the next cursor. The bug
 * called it as `this.finalizeTimestamp(...)`; invoked through the bare export the
 * function has no `this`, so every `/v1/datasets` read threw
 *   "Cannot read properties of undefined (reading 'finalizeTimestamp')" → 500.
 * The fix pins the call to `Dataset.finalizeTimestamp(...)`.
 *
 * These tests import the BARE exports (the exact wiring that lost `this` at runtime)
 * and call them against a real in-memory SQLite DB seeded via the writer. If the fix
 * is reverted they fail with the TypeError above (the awaited call rejects), instead
 * of silently regressing to a 500 in production.
 *
 * The db package resolves its dialect-specific `schemas` from ANYCRAWL_API_DB_TYPE at
 * import time, so we force SQLite before importing it (mirrors datasetWriter.test.ts).
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

// Bare exports under test — Dataset.<method> detached from the class.
let getDatasetItems: any;
let listDatasetRuns: any;
let listDatasetChanges: any;
let listDatasetsByOwner: any;
let listRunWarnings: any;
// Bound export used only to seed rows (safe — index.ts binds the writer).
let writeResultToDataset: any;

let sqlite: any;
let db: any;

const OWNER = { userId: "user-1" };
const SEARCH_MAPPING = { name: "anycrawl_search_result", version: "1.0.0" };

/** uuid of a run keyed by (dataset, producer_type, producer_id). */
const runIdOf = (datasetId: string, producerType: string, producerId: string): string =>
    (sqlite
        .prepare(
            `SELECT uuid FROM dataset_runs WHERE dataset_id = ? AND producer_type = ? AND producer_id = ?`
        )
        .get(datasetId, producerType, producerId) as any).uuid;

async function seedSearch(opts: { jobId: string; result: unknown; dataset: any }) {
    return writeResultToDataset({
        producerType: "search",
        producerId: opts.jobId,
        jobId: opts.jobId,
        scope: { kind: "job", jobId: opts.jobId },
        scopeType: "search",
        result: opts.result,
        mapping: SEARCH_MAPPING,
        owner: OWNER,
        dataset: opts.dataset,
        dbOrTx: db,
        now: new Date(),
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    // Import the real package barrel so we exercise the *bare* export wiring itself.
    const dbPkg: any = await import("../index.js");
    ({ getDatasetItems, listDatasetRuns, listDatasetChanges, listDatasetsByOwner, listRunWarnings, writeResultToDataset } =
        dbPkg);

    sqlite = new Database(":memory:");
    // Dataset tables carry FKs to parent tables (api_key, jobs, ...) we don't create here.
    sqlite.pragma("foreign_keys = OFF");
    const ddl = readFileSync(
        resolve(process.cwd(), "drizzle/SQLite/0012_dataset_core_tables.sql"),
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

describe("Dataset read bare exports keep their `this` binding (regression: this.finalizeTimestamp)", () => {
    let datasetId: string;
    let runWithWarning: string;

    beforeAll(async () => {
        // Run #1 → dataset + 3 items + 3 'created' changes.
        const out1 = await seedSearch({
            jobId: "read-1",
            result: [
                { url: "https://r.test/1", title: "a" },
                { url: "https://r.test/2", title: "b" },
                { url: "https://r.test/3", title: "c" },
            ],
            dataset: { create: { name: "Read DS" } },
        });
        datasetId = out1.datasetId;

        // Run #2 → +1 item, +1 change (total 4 items, 4 changes, 2 runs).
        await seedSearch({
            jobId: "read-2",
            result: [{ url: "https://r.test/4", title: "d" }],
            dataset: { datasetId },
        });

        // Run #3 → 1 valid item + 1 item with no key ⇒ records a `missing_item_key`
        // run warning (total 5 items, 5 changes, 3 runs, 1 warning).
        await seedSearch({
            jobId: "read-3",
            result: [
                { url: "https://r.test/5", title: "e" },
                { title: "no url here" },
            ],
            dataset: { datasetId },
        });
        runWithWarning = runIdOf(datasetId, "search", "read-3");
    });

    // Each call below routes through finalizeTimestamp. Under the reverted bug the
    // awaited promise rejects with the TypeError, failing the test.

    it("getDatasetItems returns a trimmed page + cursor (bare export)", async () => {
        const page = await getDatasetItems(db, { datasetId, limit: 2 });
        expect(page.items).toHaveLength(2); // 5 items, limit 2 → hasMore trims to 2
        expect(page.nextCursor).not.toBeNull(); // derived inside finalizeTimestamp
        expect(page.nextCursor.id).toBeTruthy();
    });

    it("listDatasetRuns returns a trimmed page + cursor (bare export)", async () => {
        const page = await listDatasetRuns(db, datasetId, { limit: 1 });
        expect(page.items).toHaveLength(1); // 3 runs, limit 1 → hasMore
        expect(page.nextCursor).not.toBeNull();
    });

    it("listDatasetChanges returns a trimmed page + cursor (bare export)", async () => {
        const page = await listDatasetChanges(db, datasetId, { limit: 2 });
        expect(page.items).toHaveLength(2); // 5 changes, limit 2 → hasMore
        expect(page.nextCursor).not.toBeNull();
    });

    it("listDatasetsByOwner returns the owner's datasets (bare export)", async () => {
        const page = await listDatasetsByOwner(db, OWNER, { limit: 5 });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items.some((d: any) => d.uuid === datasetId)).toBe(true);
    });

    it("listRunWarnings returns the run's warnings (bare export)", async () => {
        const page = await listRunWarnings(db, runWithWarning, { limit: 10 });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items[0].code).toBe("missing_item_key");
    });

    it("returns an empty page (not a throw) when there is nothing to read (bare export)", async () => {
        // finalizeTimestamp still runs on an empty result set — the reverted bug throws here too.
        const page = await getDatasetItems(db, {
            datasetId: "00000000-0000-0000-0000-000000000000",
            limit: 10,
        });
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toBeNull();
    });
});
