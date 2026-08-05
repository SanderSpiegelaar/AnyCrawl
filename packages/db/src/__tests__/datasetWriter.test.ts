import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Integration-style unit tests for DatasetWriter run against a real in-memory
 * SQLite database (the exact dataset DDL from the committed migration), passing
 * the drizzle instance in as `dbOrTx`. This exercises the real query builder,
 * unique constraints and idempotency without any live server.
 *
 * The db package resolves its dialect-specific `schemas` from
 * ANYCRAWL_API_DB_TYPE at import time, so we force SQLite before importing it.
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let DatasetWriter: any;
let DatasetSchemaMismatchError: any;
let DatasetNotFoundError: any;
let sqlite: any;
let db: any;

const OWNER = { userId: "user-1" };
const SCRAPE_MAPPING = { name: "anycrawl_scrape", version: "1.0.0" };

const countRows = (table: string): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;

const changesByType = (type: string): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM dataset_item_changes WHERE change_type = ?`).get(type) as any).c;

const SEARCH_MAPPING = { name: "anycrawl_search_result", version: "1.0.0" };
const CRAWL_MAPPING = { name: "anycrawl_crawl_page", version: "1.0.0" };

/** uuid of a run keyed by (dataset, producer_type, producer_id). */
const runIdOf = (datasetId: string, producerType: string, producerId: string): string =>
    (sqlite
        .prepare(
            `SELECT uuid FROM dataset_runs WHERE dataset_id = ? AND producer_type = ? AND producer_id = ?`
        )
        .get(datasetId, producerType, producerId) as any).uuid;

/** All run_items for a run, in the read-API order (COALESCE(sequence, maxint), uuid). */
const runItemsOf = (runId: string): any[] =>
    sqlite
        .prepare(
            `SELECT uuid, dataset_item_id, item_key, sequence, seed_key, seed_index, page_index, position
             FROM dataset_run_items WHERE dataset_run_id = ?
             ORDER BY COALESCE(sequence, 2147483647), uuid`
        )
        .all(runId) as any[];

/** uuid of the dataset_items row for a given (dataset, item_key). */
const itemIdOf = (datasetId: string, itemKey: string): string =>
    (sqlite
        .prepare(`SELECT uuid FROM dataset_items WHERE dataset_id = ? AND item_key = ?`)
        .get(datasetId, itemKey) as any).uuid;

/** General producer write (scrape/search/crawl) with optional finalize/pageIndex. */
async function writeRun(opts: {
    jobId: string;
    result: unknown;
    dataset: any;
    scopeType: "scrape" | "search" | "crawl";
    producerType: string;
    mapping: any;
    producerId?: string;
    finalizeRun?: boolean;
    pageIndex?: number;
}) {
    return DatasetWriter.writeResultToDataset({
        producerType: opts.producerType,
        producerId: opts.producerId ?? opts.jobId,
        jobId: opts.jobId,
        scope: { kind: "job", jobId: opts.jobId },
        scopeType: opts.scopeType,
        result: opts.result,
        mapping: opts.mapping,
        owner: OWNER,
        dataset: opts.dataset,
        dbOrTx: db,
        now: new Date(),
        finalizeRun: opts.finalizeRun,
        pageIndex: opts.pageIndex,
    });
}

function scrapeDoc(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { url, title: "Title", markdown: "hello world", ...extra };
}

async function writeScrape(opts: {
    jobId: string;
    result: unknown;
    dataset: any;
    mapping?: any;
    scopeType?: "scrape" | "search";
    producerType?: string;
}) {
    return DatasetWriter.writeResultToDataset({
        producerType: opts.producerType ?? "scrape",
        producerId: opts.jobId,
        jobId: opts.jobId,
        scope: { kind: "job", jobId: opts.jobId },
        scopeType: opts.scopeType ?? "scrape",
        result: opts.result,
        mapping: opts.mapping ?? SCRAPE_MAPPING,
        owner: OWNER,
        dataset: opts.dataset,
        dbOrTx: db,
        now: new Date(),
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    ({ DatasetWriter, DatasetSchemaMismatchError, DatasetNotFoundError } = await import(
        "../model/DatasetWriter.js"
    ));

    sqlite = new Database(":memory:");
    // The dataset tables carry FKs to parent tables (api_key, jobs, scheduled_tasks)
    // that we don't create here; disable FK enforcement for this isolated slice.
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

describe("DatasetWriter.writeResultToDataset (scrape lifecycle)", () => {
    let datasetId: string;
    const URL_A = "https://example.test/a";

    it("creates the dataset, run, item and a 'created' change", async () => {
        const out = await writeScrape({
            jobId: "job-1",
            result: scrapeDoc(URL_A),
            dataset: { create: { name: "My Dataset" } },
        });
        datasetId = out.datasetId;

        expect(out.status).toBe("completed");
        expect(out.itemsCreated).toBe(1);
        expect(out.itemsUpdated).toBe(0);
        expect(out.itemsUnchanged).toBe(0);
        expect(out.itemsSeen).toBe(1);
        expect(out.warnings).toHaveLength(0);

        expect(countRows("datasets")).toBe(1);
        expect(countRows("dataset_runs")).toBe(1);
        expect(countRows("dataset_items")).toBe(1);
        expect(changesByType("created")).toBe(1);

        const ds = sqlite.prepare(`SELECT item_count, active_item_count, source_type, schema_name FROM datasets WHERE uuid = ?`).get(datasetId) as any;
        expect(ds.item_count).toBe(1);
        expect(ds.active_item_count).toBe(1);
        expect(ds.source_type).toBe("scrape");
        expect(ds.schema_name).toBe("anycrawl_scrape");
    });

    it("is idempotent: replaying the same job writes nothing new", async () => {
        const out = await writeScrape({
            jobId: "job-1",
            result: scrapeDoc(URL_A),
            dataset: { datasetId },
        });
        expect(out.itemsCreated).toBe(0);
        expect(out.itemsUpdated).toBe(0);

        // No duplicate run / item / change rows.
        expect(countRows("dataset_runs")).toBe(1);
        expect(countRows("dataset_items")).toBe(1);
        expect(changesByType("created")).toBe(1);
        const ds = sqlite.prepare(`SELECT item_count FROM datasets WHERE uuid = ?`).get(datasetId) as any;
        expect(ds.item_count).toBe(1);
    });

    it("classifies an identical document from a different job as unchanged (hash-only, volatile fields excluded)", async () => {
        const out = await writeScrape({
            jobId: "job-2",
            // Different volatile platform fields — excluded from the hash.
            result: scrapeDoc(URL_A, { jobId: "job-2", timestamp: Date.now(), proxy: "base" }),
            dataset: { datasetId },
        });
        expect(out.itemsUnchanged).toBe(1);
        expect(out.itemsCreated).toBe(0);
        expect(out.itemsUpdated).toBe(0);

        expect(countRows("dataset_runs")).toBe(2); // new run for job-2
        expect(countRows("dataset_items")).toBe(1); // same item
        expect(changesByType("created")).toBe(1); // no new change
        expect(changesByType("updated")).toBe(0);
    });

    it("classifies changed business content as updated and records a field diff", async () => {
        const out = await writeScrape({
            jobId: "job-3",
            result: scrapeDoc(URL_A, { title: "New Title" }),
            dataset: { datasetId },
        });
        expect(out.itemsUpdated).toBe(1);
        expect(out.itemsCreated).toBe(0);
        expect(out.itemsUnchanged).toBe(0);

        expect(countRows("dataset_items")).toBe(1);
        expect(changesByType("updated")).toBe(1);

        const item = sqlite.prepare(`SELECT document FROM dataset_items WHERE dataset_id = ?`).get(datasetId) as any;
        expect(JSON.parse(item.document).title).toBe("New Title");

        const change = sqlite.prepare(`SELECT field_changes FROM dataset_item_changes WHERE change_type = 'updated'`).get() as any;
        const fc = JSON.parse(change.field_changes);
        expect(fc.title).toEqual({ before: "Title", after: "New Title" });
    });

    it("rejects writing to an existing dataset with an incompatible schema (409)", async () => {
        await expect(
            writeScrape({
                jobId: "job-x",
                result: scrapeDoc(URL_A),
                dataset: { datasetId },
                mapping: { name: "anycrawl_crawl_page", version: "1.0.0" },
                producerType: "crawl",
            })
        ).rejects.toBeInstanceOf(DatasetSchemaMismatchError);
    });

    it("rejects writing to a non-existent / unowned dataset (404)", async () => {
        await expect(
            writeScrape({
                jobId: "job-y",
                result: scrapeDoc(URL_A),
                dataset: { datasetId: "00000000-0000-0000-0000-000000000000" },
            })
        ).rejects.toBeInstanceOf(DatasetNotFoundError);
    });
});

describe("DatasetWriter mapping + guards", () => {
    it("splits search results per item and warns on a missing key", async () => {
        const out = await writeScrape({
            jobId: "search-1",
            scopeType: "search",
            producerType: "search",
            mapping: { name: "anycrawl_search_result", version: "1.0.0" },
            result: [
                { url: "https://s.test/1", title: "one" },
                { title: "no url here" },
            ],
            dataset: { create: { name: "Search DS" } },
        });
        expect(out.itemsCreated).toBe(1);
        expect(out.itemsSeen).toBe(2);
        expect(out.status).toBe("partial");
        expect(out.warnings.some((w: any) => w.code === "missing_item_key")).toBe(true);
    });

    it("skips oversized documents with an item_too_large warning (never truncates)", async () => {
        const huge = "x".repeat(300 * 1024);
        const out = await writeScrape({
            jobId: "big-1",
            result: scrapeDoc("https://big.test/a", { blob: huge }),
            dataset: { create: { name: "Big DS" } },
        });
        expect(out.itemsCreated).toBe(0);
        expect(out.status).toBe("partial");
        expect(out.warnings.some((w: any) => w.code === "item_too_large")).toBe(true);
    });
});

describe("DatasetWriter run membership (dataset_run_items)", () => {
    const U1 = "https://ri.test/1";
    const U2 = "https://ri.test/2";
    const U3 = "https://ri.test/3";
    const U4 = "https://ri.test/4";

    let datasetId: string;
    let run1Id: string;

    it("records membership for every created item with a contiguous sequence (finalized search run)", async () => {
        const out = await writeRun({
            jobId: "ri-s1",
            scopeType: "search",
            producerType: "search",
            mapping: SEARCH_MAPPING,
            result: [
                { url: U1, title: "a" },
                { url: U2, title: "b" },
                { url: U3, title: "c" },
            ],
            dataset: { create: { name: "RunItems DS" } },
        });
        datasetId = out.datasetId;
        expect(out.status).toBe("completed");
        expect(out.itemsCreated).toBe(3);

        run1Id = runIdOf(datasetId, "search", "ri-s1");
        const items = runItemsOf(run1Id);

        // One membership row per item seen this run.
        expect(items).toHaveLength(3);
        // Sequence is contiguous 1..N in occurrence (position) order.
        expect(items.map((r) => r.sequence)).toEqual([1, 2, 3]);
        expect(items.map((r) => r.item_key)).toEqual([U1, U2, U3]);
        // Occurrence fields for a one-shot job scope.
        expect(items.map((r) => r.position)).toEqual([0, 1, 2]);
        expect(items.every((r) => r.seed_index === 0)).toBe(true);
        expect(items.every((r) => r.page_index === 0)).toBe(true);
        expect(items.every((r) => r.seed_key === null)).toBe(true);
        // dataset_item_id links to the real dataset_items row for that key.
        for (const r of items) {
            expect(r.dataset_item_id).toBe(itemIdOf(datasetId, r.item_key));
        }
    });

    it("records membership for created + updated + unchanged items in one run", async () => {
        const out = await writeRun({
            jobId: "ri-s2",
            scopeType: "search",
            producerType: "search",
            mapping: SEARCH_MAPPING,
            result: [
                { url: U1, title: "a" }, // identical → unchanged
                { url: U2, title: "b2" }, // changed title → updated
                { url: U4, title: "d" }, // new → created
            ],
            dataset: { datasetId },
        });
        expect(out.itemsCreated).toBe(1);
        expect(out.itemsUpdated).toBe(1);
        expect(out.itemsUnchanged).toBe(1);

        const run2Id = runIdOf(datasetId, "search", "ri-s2");
        const items = runItemsOf(run2Id);

        // Membership is independent of change: all three are members.
        expect(items).toHaveLength(3);
        expect(items.map((r) => r.item_key)).toEqual([U1, U2, U4]);
        expect(items.map((r) => r.sequence)).toEqual([1, 2, 3]);
    });

    it("is idempotent on replay: no duplicate run_items and sequence is stable", async () => {
        const before = runItemsOf(run1Id);
        const totalBefore = countRows("dataset_run_items");

        // Replay the exact same producer message for run 1.
        await writeRun({
            jobId: "ri-s1",
            scopeType: "search",
            producerType: "search",
            mapping: SEARCH_MAPPING,
            result: [
                { url: U1, title: "a" },
                { url: U2, title: "b" },
                { url: U3, title: "c" },
            ],
            dataset: { datasetId },
        });

        const after = runItemsOf(run1Id);
        // Same rows, same uuids, same sequences — nothing re-inserted or re-numbered.
        expect(after).toHaveLength(3);
        expect(after.map((r) => r.sequence)).toEqual([1, 2, 3]);
        expect(after.map((r) => r.uuid)).toEqual(before.map((r) => r.uuid));
        expect(countRows("dataset_run_items")).toBe(totalBefore);
    });

    it("leaves sequence NULL for a non-finalized crawl run and accumulates members per page", async () => {
        const crawlJob = "ri-crawl-1";

        // Page 1 creates the dataset; finalizeRun:false keeps the run 'running'.
        const p1 = await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: scrapeDoc(U1),
            dataset: { create: { name: "Crawl DS" } },
            finalizeRun: false,
            pageIndex: 0,
        });
        expect(p1.status).toBe("running");
        const crawlDatasetId = p1.datasetId;

        // Page 2 of the same crawl → same run, next page index.
        await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: scrapeDoc(U2),
            dataset: { datasetId: crawlDatasetId },
            finalizeRun: false,
            pageIndex: 1,
        });

        const crawlRunId = runIdOf(crawlDatasetId, "crawl", crawlJob);
        const items = runItemsOf(crawlRunId);

        expect(items).toHaveLength(2);
        // Sequence stays NULL during a non-finalized run.
        expect(items.every((r) => r.sequence === null)).toBe(true);
        // Per-page counter is recorded; position is 0-based within each page batch.
        expect(items.map((r) => r.page_index).sort()).toEqual([0, 1]);
        expect(items.every((r) => r.position === 0)).toBe(true);

        // Replaying page 1 must not add a duplicate member or assign a sequence.
        await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: scrapeDoc(U1),
            dataset: { datasetId: crawlDatasetId },
            finalizeRun: false,
            pageIndex: 0,
        });
        const afterReplay = runItemsOf(crawlRunId);
        expect(afterReplay).toHaveLength(2);
        expect(afterReplay.every((r) => r.sequence === null)).toBe(true);
    });
});
