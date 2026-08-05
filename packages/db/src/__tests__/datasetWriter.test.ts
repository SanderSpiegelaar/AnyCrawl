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
