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
    // Apply the dataset core DDL, then the jsonb-query migration that drops the EAV
    // field_values table and adds datasets.query_fields — so the test DB matches the
    // current schema (jsonb-direct query layer + query_fields catalog snapshot).
    applyMigrations([
        "drizzle/SQLite/0012_dataset_core_tables.sql",
        "drizzle/SQLite/0017_dataset_jsonb_query.sql",
    ]);
    db = drizzle(sqlite, { schema });
});

/** Apply drizzle migration files (split on statement-breakpoint) in order. */
function applyMigrations(files: string[]): void {
    for (const file of files) {
        const ddl = readFileSync(resolve(process.cwd(), file), "utf8");
        for (const raw of ddl.split("--> statement-breakpoint")) {
            const stmt = raw.trim();
            if (stmt.length > 0) sqlite.exec(stmt);
        }
    }
}

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

describe("DatasetWriter query_fields catalog snapshot (replaces EAV field_values)", () => {
    const PROJ_MAPPING = {
        name: "anycrawl_scrape",
        version: "1.0.0",
        projections: [
            { name: "price", path: "/price/amount", type: "number" },
            { name: "in_stock", path: "/inStock", type: "boolean" },
            { name: "brand", path: "/brand", type: "string" },
            { name: "published_at", path: "/publishedAt", type: "timestamptz" },
        ],
    };

    const queryFieldsOf = (datasetId: string): any[] => {
        const row = sqlite
            .prepare(`SELECT query_fields FROM datasets WHERE uuid = ?`)
            .get(datasetId) as any;
        return row?.query_fields ? JSON.parse(row.query_fields) : [];
    };

    it("snapshots the projection catalog onto datasets.query_fields at create", async () => {
        const out = await writeScrape({
            jobId: "qf-1",
            mapping: PROJ_MAPPING,
            result: scrapeDoc("https://qf.test/p1", {
                price: { amount: 19.95 },
                inStock: true,
                brand: "Acme",
                publishedAt: "2026-01-02T03:04:05.000Z",
            }),
            dataset: { create: { name: "QueryFields DS" } },
        });
        expect(out.itemsCreated).toBe(1);

        const fields = queryFieldsOf(out.datasetId);
        expect(fields).toEqual([
            { field: "price", path: "/price/amount", type: "number" },
            { field: "in_stock", path: "/inStock", type: "boolean" },
            { field: "brand", path: "/brand", type: "string" },
            { field: "published_at", path: "/publishedAt", type: "timestamptz" },
        ]);

        // No per-item projection rows are written anymore (document is the sole store).
        const hasFieldValuesTable = sqlite
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dataset_item_field_values'`)
            .get();
        expect(hasFieldValuesTable).toBeUndefined();
    });

    it("leaves query_fields null when the mapping declares no projections", async () => {
        const out = await writeScrape({
            jobId: "qf-none",
            mapping: SCRAPE_MAPPING, // no projections
            result: scrapeDoc("https://qf.test/none", { price: { amount: 1 } }),
            dataset: { create: { name: "No QueryFields DS" } },
        });
        expect(out.itemsCreated).toBe(1);
        expect(queryFieldsOf(out.datasetId)).toEqual([]);
    });
});

describe("DatasetWriter ensure-by-name accumulation", () => {
    const datasetsNamed = (name: string): any[] =>
        sqlite
            .prepare(`SELECT uuid, item_count FROM datasets WHERE name = ? AND deleted_at IS NULL`)
            .all(name) as any[];

    it("reuses one dataset for repeated create-by-name runs (same owner) and accumulates items", async () => {
        const NAME = "Accumulate DS";

        const first = await writeScrape({
            jobId: "acc-1",
            result: scrapeDoc("https://acc.test/1"),
            dataset: { create: { name: NAME } },
        });
        const second = await writeScrape({
            jobId: "acc-2",
            result: scrapeDoc("https://acc.test/2"),
            dataset: { create: { name: NAME } },
        });

        // Both runs resolved to the SAME dataset.
        expect(second.datasetId).toBe(first.datasetId);
        expect(datasetsNamed(NAME)).toHaveLength(1);

        // Items from both runs accumulated into it (2 distinct URLs → 2 items).
        expect(first.itemsCreated).toBe(1);
        expect(second.itemsCreated).toBe(1);
        const ds = datasetsNamed(NAME)[0];
        expect(ds.item_count).toBe(2);

        // Two runs recorded against the one dataset (per-producer runs still distinct).
        expect(countRows("dataset_runs")).toBeGreaterThanOrEqual(2);
    });

    it("dedups + change-tracks an identical then changed item across ensure-by-name runs", async () => {
        const NAME = "Accumulate Dedup DS";
        const URL = "https://acc-dedup.test/x";

        const r1 = await writeScrape({ jobId: "ad-1", result: scrapeDoc(URL), dataset: { create: { name: NAME } } });
        // Same content, different job → reuse dataset, item unchanged (dedup by hash).
        const r2 = await writeScrape({ jobId: "ad-2", result: scrapeDoc(URL), dataset: { create: { name: NAME } } });
        // Changed content → reuse dataset, item updated (change tracked).
        const r3 = await writeScrape({
            jobId: "ad-3",
            result: scrapeDoc(URL, { title: "Changed" }),
            dataset: { create: { name: NAME } },
        });

        expect(r2.datasetId).toBe(r1.datasetId);
        expect(r3.datasetId).toBe(r1.datasetId);
        expect(r1.itemsCreated).toBe(1);
        expect(r2.itemsUnchanged).toBe(1);
        expect(r3.itemsUpdated).toBe(1);

        // One dataset, one item, one created + one updated change row.
        expect(datasetsNamed(NAME)).toHaveLength(1);
        const ds = datasetsNamed(NAME)[0];
        expect(ds.item_count).toBe(1);
    });

    it("does not merge same-name datasets across different owners", async () => {
        const NAME = "Owner Scoped DS";
        const A = await DatasetWriter.writeResultToDataset({
            producerType: "scrape",
            producerId: "own-a",
            jobId: "own-a",
            scope: { kind: "job", jobId: "own-a" },
            scopeType: "scrape",
            result: scrapeDoc("https://own.test/a"),
            mapping: SCRAPE_MAPPING,
            owner: { userId: "owner-A" },
            dataset: { create: { name: NAME } },
            dbOrTx: db,
            now: new Date(),
        });
        const B = await DatasetWriter.writeResultToDataset({
            producerType: "scrape",
            producerId: "own-b",
            jobId: "own-b",
            scope: { kind: "job", jobId: "own-b" },
            scopeType: "scrape",
            result: scrapeDoc("https://own.test/b"),
            mapping: SCRAPE_MAPPING,
            owner: { userId: "owner-B" },
            dataset: { create: { name: NAME } },
            dbOrTx: db,
            now: new Date(),
        });

        // Distinct owners → distinct datasets even with an identical name.
        expect(B.datasetId).not.toBe(A.datasetId);
        expect(datasetsNamed(NAME)).toHaveLength(2);
    });
});

describe("DatasetWriter.finalizeCrawlDatasetRun (crawl finalize)", () => {
    const runStatusOf = (runId: string): any =>
        sqlite
            .prepare(`SELECT status, warning_count, finished_at FROM dataset_runs WHERE uuid = ?`)
            .get(runId) as any;

    /** Write N crawl pages (finalizeRun:false) into a fresh dataset; return ids. */
    async function crawlPages(
        crawlJob: string,
        urls: string[]
    ): Promise<{ datasetId: string; runId: string }> {
        const first = await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: scrapeDoc(urls[0] as string),
            dataset: { create: { name: `Crawl Finalize ${crawlJob}` } },
            finalizeRun: false,
            pageIndex: 0,
        });
        const datasetId = first.datasetId;
        for (let i = 1; i < urls.length; i++) {
            await writeRun({
                jobId: crawlJob,
                producerId: crawlJob,
                scopeType: "crawl",
                producerType: "crawl",
                mapping: CRAWL_MAPPING,
                result: scrapeDoc(urls[i] as string),
                dataset: { datasetId },
                finalizeRun: false,
                pageIndex: i,
            });
        }
        return { datasetId, runId: runIdOf(datasetId, "crawl", crawlJob) };
    }

    it("moves a running crawl run to completed and assigns a contiguous sequence", async () => {
        const crawlJob = "cf-1";
        const { datasetId, runId } = await crawlPages(crawlJob, [
            "https://cf.test/1",
            "https://cf.test/2",
            "https://cf.test/3",
        ]);

        // Before finalize: run is 'running' and members are unsequenced.
        expect(runStatusOf(runId).status).toBe("running");
        expect(runItemsOf(runId).every((r) => r.sequence === null)).toBe(true);

        const out = await DatasetWriter.finalizeCrawlDatasetRun({
            datasetId,
            producerType: "crawl",
            producerId: crawlJob,
            dbOrTx: db,
        });

        expect(out.finalized).toBe(true);
        expect(out.status).toBe("completed");
        expect(out.datasetRunId).toBe(runId);

        const after = runStatusOf(runId);
        expect(after.status).toBe("completed");
        expect(after.finished_at).not.toBeNull();

        const items = runItemsOf(runId);
        expect(items.map((r) => r.sequence)).toEqual([1, 2, 3]);
        // Sequence follows page order.
        expect(items.map((r) => r.item_key)).toEqual([
            "https://cf.test/1",
            "https://cf.test/2",
            "https://cf.test/3",
        ]);
    });

    it("is idempotent: re-finalizing is a no-op and preserves the sequence", async () => {
        const crawlJob = "cf-2";
        const { datasetId, runId } = await crawlPages(crawlJob, [
            "https://cf2.test/1",
            "https://cf2.test/2",
        ]);

        const first = await DatasetWriter.finalizeCrawlDatasetRun({
            datasetId,
            producerId: crawlJob,
            dbOrTx: db,
        });
        expect(first.finalized).toBe(true);
        const seqAfterFirst = runItemsOf(runId).map((r) => r.sequence);
        const finishedAfterFirst = runStatusOf(runId).finished_at;

        const second = await DatasetWriter.finalizeCrawlDatasetRun({
            datasetId,
            producerId: crawlJob,
            dbOrTx: db,
        });
        // Second call reports the run was already terminal; nothing re-numbered.
        expect(second.finalized).toBe(false);
        expect(second.status).toBe("completed");
        expect(runItemsOf(runId).map((r) => r.sequence)).toEqual(seqAfterFirst);
        expect(runStatusOf(runId).status).toBe("completed");
        expect(runStatusOf(runId).finished_at).toEqual(finishedAfterFirst);
    });

    it("finalizes to partial when the run accumulated warnings across pages", async () => {
        const crawlJob = "cf-3";
        // Page 1: a valid page → one member.
        const first = await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: scrapeDoc("https://cf3.test/ok"),
            dataset: { create: { name: "Crawl Partial DS" } },
            finalizeRun: false,
            pageIndex: 0,
        });
        const datasetId = first.datasetId;
        // Page 2: a crawl page with no URL → missing_item_key warning, no member.
        await writeRun({
            jobId: crawlJob,
            producerId: crawlJob,
            scopeType: "crawl",
            producerType: "crawl",
            mapping: CRAWL_MAPPING,
            result: { title: "no url here" },
            dataset: { datasetId },
            finalizeRun: false,
            pageIndex: 1,
        });

        const runId = runIdOf(datasetId, "crawl", crawlJob);
        expect(runStatusOf(runId).warning_count).toBeGreaterThan(0);

        const out = await DatasetWriter.finalizeCrawlDatasetRun({
            datasetId,
            producerId: crawlJob,
            dbOrTx: db,
        });
        expect(out.status).toBe("partial");
        expect(runStatusOf(runId).status).toBe("partial");
        // The single valid page is sequenced.
        expect(runItemsOf(runId).map((r) => r.sequence)).toEqual([1]);
    });

    it("is a no-op when no matching dataset run exists (non-dataset crawl)", async () => {
        const out = await DatasetWriter.finalizeCrawlDatasetRun({
            datasetId: "00000000-0000-0000-0000-000000000000",
            producerId: "no-such-crawl-job",
            dbOrTx: db,
        });
        expect(out).toEqual({ finalized: false, datasetRunId: null, status: null });
    });
});
