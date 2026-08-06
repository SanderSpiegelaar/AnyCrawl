import { and, eq, sql } from "drizzle-orm";
import { getDB, schemas } from "../db/index.js";
import { computeDocumentHash } from "./documentHash.js";

type DBExecutor = any;

/**
 * Immutable template version snapshots (platform §9.1).
 *
 * A revision freezes the full execution config + output schema for a template so
 * historical Template Runs and Schedules stay reproducible and unaffected by
 * later template edits. `UNIQUE(template_uuid, config_hash)` makes concurrent
 * get-or-create idempotent — the same normalized config is only ever frozen once
 * (§9.1 rule 3 / rule 6). `templates.current_revision_uuid` points at the active
 * revision; it is a plain nullable column (no FK) to avoid a circular dependency
 * with this table (see the schema note on `current_revision_uuid`).
 *
 * Mirrors the static-class style of Template / Dataset: `getDB()`-backed by
 * default, with an optional `dbOrTx` so the pointer flip in
 * `freezeCurrentAndSetPointer` runs inside a single transaction and so the write
 * paths are testable against an injected drizzle instance.
 */
export interface FreezeRevisionParams {
    templateUuid: string;
    version: string;
    /** Full normalized execution config to snapshot (reqOptions, runtime, variables, …). */
    configSnapshot: Record<string, unknown> | null | undefined;
    /** Output schema snapshot; null when the template declares no output schema. */
    schemaSnapshot?: Record<string, unknown> | null;
    /** Reuse an existing transaction/executor; otherwise a fresh getDB() connection. */
    dbOrTx?: DBExecutor;
    /** Injected clock for deterministic tests. */
    now?: Date;
}

export class TemplateRevision {
    /**
     * Deterministic content hash of a normalized config object. Object keys are
     * sorted and array order preserved (reuses the Dataset document-hash
     * normalization), so logically-identical configs always hash identically and
     * two revisions only collide when their frozen config is genuinely the same.
     */
    static computeConfigHash(config: unknown): string {
        return computeDocumentHash(config ?? null);
    }

    /**
     * Idempotently freeze a revision. The `config_hash` covers the complete
     * reproducible snapshot (config + schema), so a change to either part yields a
     * new revision while a re-freeze of the same content is a no-op. Relies on the
     * `uq_template_revision` unique index via onConflictDoNothing + re-select, so
     * concurrent writers and rollout retries converge on a single row.
     */
    static async freeze(params: FreezeRevisionParams): Promise<any> {
        const db = params.dbOrTx ?? (await getDB());
        const now = params.now ?? new Date();
        const configSnapshot = params.configSnapshot ?? {};
        const schemaSnapshot = params.schemaSnapshot ?? null;

        // Hash over the full immutable snapshot so a schema-only change also
        // produces a distinct revision (§9.1 rule 5/6: the revision includes the
        // output schema as part of the complete execution config).
        const configHash = TemplateRevision.computeConfigHash({
            config: configSnapshot,
            schema: schemaSnapshot,
        });

        const [inserted] = await db
            .insert(schemas.templateRevisions)
            .values({
                templateUuid: params.templateUuid,
                version: params.version,
                configHash,
                configSnapshot,
                schemaSnapshot,
                createdAt: now,
            })
            .onConflictDoNothing({
                target: [
                    schemas.templateRevisions.templateUuid,
                    schemas.templateRevisions.configHash,
                ],
            })
            .returning();

        if (inserted) return inserted;

        // Already frozen (or lost the insert race) — re-select the canonical row.
        const [existing] = await db
            .select()
            .from(schemas.templateRevisions)
            .where(
                and(
                    eq(schemas.templateRevisions.templateUuid, params.templateUuid),
                    eq(schemas.templateRevisions.configHash, configHash)
                )
            )
            .limit(1);
        return existing ?? null;
    }

    /** Fetch a single revision by its uuid. */
    static async get(uuid: string, dbOrTx?: DBExecutor): Promise<any | null> {
        const db = dbOrTx ?? (await getDB());
        const rows = await db
            .select()
            .from(schemas.templateRevisions)
            .where(eq(schemas.templateRevisions.uuid, uuid))
            .limit(1);
        return rows[0] ?? null;
    }

    /** All revisions of a template in chronological order (created_at ASC, uuid ASC). */
    static async listByTemplate(templateUuid: string, dbOrTx?: DBExecutor): Promise<any[]> {
        const db = dbOrTx ?? (await getDB());
        return db
            .select()
            .from(schemas.templateRevisions)
            .where(eq(schemas.templateRevisions.templateUuid, templateUuid))
            .orderBy(
                sql`${schemas.templateRevisions.createdAt} ASC, ${schemas.templateRevisions.uuid} ASC`
            );
    }

    /**
     * Load a template by its business id, freeze its current config + output schema
     * into a revision, and point `templates.current_revision_uuid` at it — all in a
     * single transaction (§9.1 rule 7). Idempotent: re-running with an unchanged
     * template resolves to the same revision (via `uq_template_revision`) and leaves
     * the pointer unchanged. Returns the resolved revision, or null when no template
     * matches `templateId`.
     */
    static async freezeCurrentAndSetPointer(
        templateId: string,
        opts?: { dbOrTx?: DBExecutor; now?: Date }
    ): Promise<any | null> {
        const now = opts?.now ?? new Date();

        const exec = async (tx: DBExecutor): Promise<any | null> => {
            // Read only the columns needed to build the snapshot + flip the pointer.
            // A narrow projection keeps this decoupled from unrelated template columns.
            const [tpl] = await tx
                .select({
                    uuid: schemas.templates.uuid,
                    version: schemas.templates.version,
                    templateType: schemas.templates.templateType,
                    pricing: schemas.templates.pricing,
                    reqOptions: schemas.templates.reqOptions,
                    customHandlers: schemas.templates.customHandlers,
                    variables: schemas.templates.variables,
                    metadata: schemas.templates.metadata,
                    trusted: schemas.templates.trusted,
                })
                .from(schemas.templates)
                .where(eq(schemas.templates.templateId, templateId))
                .limit(1);

            if (!tpl) return null;

            const { configSnapshot, schemaSnapshot } =
                TemplateRevision.buildSnapshotFromTemplate(tpl);

            const revision = await TemplateRevision.freeze({
                templateUuid: tpl.uuid,
                version: tpl.version,
                configSnapshot,
                schemaSnapshot,
                dbOrTx: tx,
                now,
            });

            await tx
                .update(schemas.templates)
                .set({ currentRevisionUuid: revision.uuid, updatedAt: now })
                .where(eq(schemas.templates.uuid, tpl.uuid));

            return revision;
        };

        if (opts?.dbOrTx) return exec(opts.dbOrTx);
        const db = await getDB();
        return db.transaction((tx: DBExecutor) => exec(tx));
    }

    /**
     * Derive the frozen config + schema snapshots from a template row. The config
     * snapshot captures everything that affects execution; the schema snapshot is
     * the template's declared output schema (from metadata) when present, else null.
     * Uses loose access so it stays independent of the @anycrawl/libs TemplateConfig
     * type (owned by another layer).
     */
    private static buildSnapshotFromTemplate(row: any): {
        configSnapshot: Record<string, unknown>;
        schemaSnapshot: Record<string, unknown> | null;
    } {
        const metadata = (row.metadata as Record<string, unknown> | null | undefined) ?? null;
        const outputSchema =
            metadata && typeof metadata === "object"
                ? ((metadata as any).outputSchema ?? null)
                : null;

        const configSnapshot: Record<string, unknown> = {
            templateType: row.templateType ?? null,
            version: row.version ?? null,
            pricing: row.pricing ?? null,
            reqOptions: row.reqOptions ?? null,
            customHandlers: row.customHandlers ?? null,
            variables: row.variables ?? null,
            metadata: metadata,
            trusted: row.trusted ?? false,
        };

        return {
            configSnapshot,
            schemaSnapshot: (outputSchema as Record<string, unknown> | null) ?? null,
        };
    }
}
