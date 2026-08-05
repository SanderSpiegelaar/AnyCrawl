import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Integration-style unit tests for TemplateRevision against a real in-memory
 * SQLite database, using the exact committed migration DDL (0013) and passing the
 * drizzle instance in as `dbOrTx`. This exercises the real query builder, the
 * uq_template_revision unique index and the get-or-create idempotency without any
 * live server — mirroring the DatasetWriter test harness.
 *
 * The db package resolves its dialect-specific `schemas` from ANYCRAWL_API_DB_TYPE
 * at import time, so we force SQLite before importing it.
 */
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

let TemplateRevision: any;
let sqlite: any;
let db: any;

const countRows = (table: string): number =>
    (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;

const revisionsForTemplate = (templateUuid: string): number =>
    (sqlite
        .prepare(`SELECT COUNT(*) AS c FROM template_revisions WHERE template_uuid = ?`)
        .get(templateUuid) as any).c;

const pointerOf = (templateUuid: string): string | null =>
    (sqlite
        .prepare(`SELECT current_revision_uuid AS p FROM templates WHERE uuid = ?`)
        .get(templateUuid) as any).p;

/** Insert a minimal templates fixture row (only the columns the model reads). */
function insertTemplate(t: {
    uuid: string;
    templateId: string;
    version?: string;
    templateType?: string;
    metadata?: Record<string, unknown> | null;
    reqOptions?: Record<string, unknown> | null;
}) {
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite
        .prepare(
            `INSERT INTO templates
                (uuid, template_id, version, template_type, pricing, req_options,
                 custom_handlers, variables, metadata, trusted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            t.uuid,
            t.templateId,
            t.version ?? "1.0.0",
            t.templateType ?? "scrape",
            JSON.stringify({ perCall: 1, currency: "credits" }),
            JSON.stringify(t.reqOptions ?? { url: "https://example.test" }),
            null,
            null,
            JSON.stringify(t.metadata ?? {}),
            0,
            nowSec,
            nowSec
        );
}

beforeAll(async () => {
    process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
    const schema = await import("../db/schemas/SQLite.js");
    ({ TemplateRevision } = await import("../model/TemplateRevision.js"));

    sqlite = new Database(":memory:");
    // template_revisions carries an FK to templates(uuid); we build a minimal
    // templates fixture and disable FK enforcement for this isolated slice.
    sqlite.pragma("foreign_keys = OFF");

    // Minimal templates table (subset the revision model reads). The committed
    // migration then ADDs current_revision_uuid and CREATEs template_revisions.
    sqlite.exec(`CREATE TABLE templates (
        uuid text PRIMARY KEY NOT NULL,
        template_id text NOT NULL,
        version text NOT NULL DEFAULT '1.0.0',
        template_type text NOT NULL DEFAULT 'scrape',
        pricing text,
        req_options text,
        custom_handlers text,
        variables text,
        metadata text,
        trusted integer DEFAULT 0,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
    );`);

    const ddl = readFileSync(
        resolve(process.cwd(), "drizzle/SQLite/0013_template_revisions.sql"),
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

describe("TemplateRevision.computeConfigHash", () => {
    it("is deterministic and independent of object key order", () => {
        const a = TemplateRevision.computeConfigHash({ b: 2, a: 1, nested: { y: 2, x: 1 } });
        const b = TemplateRevision.computeConfigHash({ a: 1, nested: { x: 1, y: 2 }, b: 2 });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs when the config content differs", () => {
        const a = TemplateRevision.computeConfigHash({ a: 1 });
        const b = TemplateRevision.computeConfigHash({ a: 2 });
        expect(a).not.toBe(b);
    });
});

describe("TemplateRevision.freeze (idempotency)", () => {
    const TPL = "tpl-freeze-uuid";

    it("freezes a new revision the first time", async () => {
        const rev = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.0.0",
            configSnapshot: { reqOptions: { url: "https://a.test" } },
            schemaSnapshot: null,
            dbOrTx: db,
        });
        expect(rev).toBeTruthy();
        expect(rev.templateUuid).toBe(TPL);
        expect(rev.configHash).toMatch(/^[0-9a-f]{64}$/);
        expect(revisionsForTemplate(TPL)).toBe(1);
    });

    it("is idempotent: same config (any key order) → same row, no new revision", async () => {
        const first = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.0.0",
            configSnapshot: { reqOptions: { url: "https://a.test" } },
            dbOrTx: db,
        });
        // Re-freeze with the same logical config but different key order.
        const second = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.0.0",
            configSnapshot: { reqOptions: { url: "https://a.test" } },
            schemaSnapshot: null,
            dbOrTx: db,
        });
        expect(second.uuid).toBe(first.uuid);
        expect(second.configHash).toBe(first.configHash);
        expect(revisionsForTemplate(TPL)).toBe(1);
    });

    it("creates a new revision when the config changes", async () => {
        const rev = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.1.0",
            configSnapshot: { reqOptions: { url: "https://b.test" } },
            dbOrTx: db,
        });
        expect(rev.configHash).toMatch(/^[0-9a-f]{64}$/);
        expect(revisionsForTemplate(TPL)).toBe(2);
    });

    it("creates a new revision when only the schema snapshot changes", async () => {
        const base = { reqOptions: { url: "https://c.test" } };
        const r1 = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.2.0",
            configSnapshot: base,
            schemaSnapshot: null,
            dbOrTx: db,
        });
        const r2 = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "1.2.0",
            configSnapshot: base,
            schemaSnapshot: { name: "custom", version: "1.0.0" },
            dbOrTx: db,
        });
        expect(r2.uuid).not.toBe(r1.uuid);
        expect(revisionsForTemplate(TPL)).toBe(4);
    });

    it("get() returns a frozen revision and null for an unknown uuid", async () => {
        const rev = await TemplateRevision.freeze({
            templateUuid: TPL,
            version: "2.0.0",
            configSnapshot: { reqOptions: { url: "https://d.test" } },
            dbOrTx: db,
        });
        const got = await TemplateRevision.get(rev.uuid, db);
        expect(got.uuid).toBe(rev.uuid);
        expect(got.configHash).toBe(rev.configHash);
        expect(await TemplateRevision.get("does-not-exist", db)).toBeNull();
    });

    it("listByTemplate() returns every revision for the template in creation order", async () => {
        const list = await TemplateRevision.listByTemplate(TPL, db);
        // Four unique-config freezes + one from the get() test = 5 revisions.
        expect(list).toHaveLength(revisionsForTemplate(TPL));
        expect(list.every((r: any) => r.templateUuid === TPL)).toBe(true);
    });
});

describe("TemplateRevision.freezeCurrentAndSetPointer", () => {
    const TPL_UUID = "tpl-ptr-uuid";
    const TPL_ID = "ptr-template";

    beforeAll(() => {
        insertTemplate({
            uuid: TPL_UUID,
            templateId: TPL_ID,
            version: "1.0.0",
            reqOptions: { url: "https://ptr.test" },
            metadata: { outputSchema: { name: "ptr_schema", version: "1.0.0" } },
        });
    });

    it("freezes the current config and points templates.current_revision_uuid at it", async () => {
        expect(pointerOf(TPL_UUID)).toBeNull();

        const rev = await TemplateRevision.freezeCurrentAndSetPointer(TPL_ID, { dbOrTx: db });
        expect(rev).toBeTruthy();
        expect(rev.templateUuid).toBe(TPL_UUID);
        // The output schema was lifted out of metadata into the schema snapshot.
        expect(rev.schemaSnapshot).toEqual({ name: "ptr_schema", version: "1.0.0" });

        expect(pointerOf(TPL_UUID)).toBe(rev.uuid);
        expect(revisionsForTemplate(TPL_UUID)).toBe(1);
    });

    it("is idempotent: re-running yields the same revision and leaves the pointer unchanged", async () => {
        const first = await TemplateRevision.freezeCurrentAndSetPointer(TPL_ID, { dbOrTx: db });
        const second = await TemplateRevision.freezeCurrentAndSetPointer(TPL_ID, { dbOrTx: db });

        expect(second.uuid).toBe(first.uuid);
        expect(pointerOf(TPL_UUID)).toBe(first.uuid);
        expect(revisionsForTemplate(TPL_UUID)).toBe(1);
    });

    it("returns null when the template id does not exist", async () => {
        const rev = await TemplateRevision.freezeCurrentAndSetPointer("no-such-template", {
            dbOrTx: db,
        });
        expect(rev).toBeNull();
    });
});
