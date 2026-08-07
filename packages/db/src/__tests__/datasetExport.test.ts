import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Model-level tests for the Dataset export helpers (create / list / get /
 * update-status), run against a real in-memory SQLite database seeded with the
 * committed migrations — same approach as datasetWriter.test.ts / datasetRead.test.ts.
 *
 * Imports the BARE exports from the package barrel (`createDatasetExport` etc.,
 * `export const createDatasetExport = DatasetExport.create;` in index.ts) so this
 * also exercises the real wiring, mirroring the `this`-binding regression coverage
 * in datasetRead.test.ts.
 *
 * The db package resolves its dialect-specific `schemas` from ANYCRAWL_API_DB_TYPE
 * at import time, so we force SQLite before importing it.
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let createDataset: any;
let createDatasetExport: any;
let listDatasetExports: any;
let getDatasetExport: any;
let updateDatasetExportStatus: any;

let sqlite: any;
let db: any;

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

async function makeDataset(name: string): Promise<any> {
    return createDataset(db, {
        userId: "user-1",
        name,
        schemaName: "anycrawl_scrape",
        schemaVersion: "1.0.0",
    });
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    const dbPkg: any = await import("../index.js");
    ({
        createDataset,
        createDatasetExport,
        listDatasetExports,
        getDatasetExport,
        updateDatasetExportStatus,
    } = dbPkg);

    sqlite = new Database(":memory:");
    // Dataset tables carry FKs to parent tables (api_key, jobs, ...) we don't create here.
    sqlite.pragma("foreign_keys = OFF");
    // Core DDL, the jsonb-query migration, then the dataset_exports migration under test.
    applyMigrations([
        "drizzle/SQLite/0012_dataset_core_tables.sql",
        "drizzle/SQLite/0017_dataset_jsonb_query.sql",
        "drizzle/SQLite/0018_modern_mandrill.sql",
    ]);
    db = drizzle(sqlite, { schema });
});

afterAll(() => {
    sqlite?.close();
});

describe("DatasetExport model helpers", () => {
    it("createDatasetExport inserts a queued row scoped to the dataset", async () => {
        const dataset = await makeDataset("Export DS 1");
        const row = await createDatasetExport(db, { datasetId: dataset.uuid, format: "jsonl" });

        expect(row.uuid).toBeTruthy();
        expect(row.datasetId).toBe(dataset.uuid);
        expect(row.format).toBe("jsonl");
        expect(row.status).toBe("queued");
        expect(row.itemCount).toBeNull();
        expect(row.fileKey).toBeNull();
        expect(row.error).toBeNull();
        expect(row.completedAt).toBeNull();
    });

    it("listDatasetExports cursor-paginates within a dataset without cross-dataset leakage", async () => {
        const datasetA = await makeDataset("Export DS A");
        const datasetB = await makeDataset("Export DS B");

        const a1 = await createDatasetExport(db, { datasetId: datasetA.uuid, format: "jsonl" });
        const a2 = await createDatasetExport(db, { datasetId: datasetA.uuid, format: "csv" });
        const a3 = await createDatasetExport(db, { datasetId: datasetA.uuid, format: "jsonl" });
        // Belongs to a different dataset — must never appear in datasetA's list.
        await createDatasetExport(db, { datasetId: datasetB.uuid, format: "csv" });

        const seenIds = new Set<string>();
        let cursor: any = null;
        let pages = 0;
        for (; ;) {
            const page = await listDatasetExports(db, datasetA.uuid, { limit: 2, cursor });
            pages++;
            for (const item of page.items) {
                expect(item.datasetId).toBe(datasetA.uuid);
                seenIds.add(item.uuid);
            }
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
            // Guard against an infinite loop if pagination regresses.
            expect(pages).toBeLessThan(10);
        }

        expect(seenIds).toEqual(new Set([a1.uuid, a2.uuid, a3.uuid]));
        expect(pages).toBeGreaterThan(1); // limit 2 over 3 rows must produce >1 page
    });

    it("getDatasetExport returns null for a wrong-dataset exportId (404-not-403 shape)", async () => {
        const datasetA = await makeDataset("Export DS Get A");
        const datasetB = await makeDataset("Export DS Get B");
        const row = await createDatasetExport(db, { datasetId: datasetA.uuid, format: "csv" });

        const ownScoped = await getDatasetExport(db, datasetA.uuid, row.uuid);
        expect(ownScoped?.uuid).toBe(row.uuid);

        const crossDataset = await getDatasetExport(db, datasetB.uuid, row.uuid);
        expect(crossDataset).toBeNull();

        const unknownId = await getDatasetExport(db, datasetA.uuid, "00000000-0000-0000-0000-000000000000");
        expect(unknownId).toBeNull();
    });

    it("updateDatasetExportStatus patches status/item_count/file_key/completed_at on success", async () => {
        const dataset = await makeDataset("Export DS Update Success");
        const row = await createDatasetExport(db, { datasetId: dataset.uuid, format: "jsonl" });

        await updateDatasetExportStatus(db, row.uuid, { status: "running" });
        let updated = await getDatasetExport(db, dataset.uuid, row.uuid);
        expect(updated.status).toBe("running");

        const completedAt = new Date();
        await updateDatasetExportStatus(db, row.uuid, {
            status: "completed",
            itemCount: 42,
            fileKey: `dataset-exports/${dataset.uuid}/${row.uuid}.jsonl`,
            completedAt,
        });
        updated = await getDatasetExport(db, dataset.uuid, row.uuid);
        expect(updated.status).toBe("completed");
        expect(updated.itemCount).toBe(42);
        expect(updated.fileKey).toBe(`dataset-exports/${dataset.uuid}/${row.uuid}.jsonl`);
        expect(updated.completedAt).toBeInstanceOf(Date);
    });

    it("updateDatasetExportStatus patches status/error on failure", async () => {
        const dataset = await makeDataset("Export DS Update Failure");
        const row = await createDatasetExport(db, { datasetId: dataset.uuid, format: "csv" });

        await updateDatasetExportStatus(db, row.uuid, {
            status: "failed",
            error: "boom",
            completedAt: new Date(),
        });
        const updated = await getDatasetExport(db, dataset.uuid, row.uuid);
        expect(updated.status).toBe("failed");
        expect(updated.error).toBe("boom");
        expect(updated.fileKey).toBeNull();
    });
});
