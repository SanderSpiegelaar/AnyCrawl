import { and, eq, sql } from "drizzle-orm";
import { log } from "@anycrawl/libs/log";
import type { OwnerContext } from "@anycrawl/libs";
import { getDB, schemas } from "../db/index.js";
import { getOwnedDataset } from "./DatasetAccess.js";
import { computeDocumentHash, shallowFieldDiff } from "./documentHash.js";

type DBExecutor = any;

/** Normalized documents larger than this (bytes) are skipped, never truncated (§11.3 rule 6). */
const MAX_ITEM_BYTES = 256 * 1024;

/**
 * Volatile platform run/time fields excluded from the document hash by default.
 * These are stored in the document but never flip the hash on re-scrape. The
 * mapping's own `hashExcludePaths` (e.g. Craigslist `/provenance/scrapedAt`) are
 * merged on top of these.
 */
const PLATFORM_HASH_EXCLUDE_PATHS = [
    "/jobId",
    "/proxy",
    "/timestamp",
    "/cachedAt",
    "/maxAge",
    "/fromCache",
    "/creditsUsed",
    "/scrapedAt",
];

export type DatasetScopeType = "scrape" | "crawl" | "search" | "orchestrated";

export interface DatasetProjectionSpec {
    name: string;
    type: "string" | "number" | "boolean" | "timestamptz";
    /** JSON-pointer-ish path into the document ("/price/amount" or "price"). */
    path: string;
}

export interface DatasetMapping {
    /** Dataset schema name, e.g. "anycrawl_scrape". */
    name: string;
    /** Dataset schema version, e.g. "1.0.0". */
    version: string;
    /** For custom outputs: path to the array to split into items. */
    itemsPath?: string;
    /** For custom outputs: path to the stable item key within each candidate. */
    itemKeyPath?: string;
    /** Extra document paths to strip before hashing. */
    hashExcludePaths?: string[];
    /** Optional typed projections written to dataset_item_field_values. */
    projections?: DatasetProjectionSpec[];
}

export interface DatasetCreateSpec {
    name: string;
    description?: string;
    retentionPolicy?: { item_days?: number; change_days?: number } | null;
}

export type DatasetTarget = { datasetId: string } | { create: DatasetCreateSpec };

export interface WriteResultToDatasetParams {
    producerType: string;
    producerId: string;
    jobId: string;
    scope: { kind: "job"; jobId: string };
    scopeType: DatasetScopeType;
    /** The producer result: whole page (scrape/crawl) or the search response. */
    result: unknown;
    mapping: DatasetMapping;
    owner: OwnerContext;
    dataset: DatasetTarget;
    /** Injected clock for deterministic tests. */
    now?: Date;
    /** Reuse an existing transaction (crawl worker); otherwise a new tx is opened. */
    dbOrTx?: DBExecutor;
    /**
     * When true (default) the run is moved to a terminal status (completed/partial)
     * at the end. Crawl per-page writes pass `false` so the run stays `running`
     * while pages accumulate.
     */
    finalizeRun?: boolean;
    /**
     * 0-based page counter for the occurrence ordering on dataset_run_items. Crawl
     * per-page writes may supply an increasing index so pages sort deterministically;
     * one-shot producers (scrape/search) omit it and it defaults to 0.
     */
    pageIndex?: number;
}

export interface RunWarning {
    code: string;
    message?: string;
    scope?: string;
    itemKey?: string;
    url?: string;
}

export type DatasetRunStatus = "running" | "completed" | "partial" | "failed";

export interface WriteResultToDatasetOutcome {
    datasetId: string;
    datasetRunId: string;
    status: DatasetRunStatus;
    itemsSeen: number;
    itemsCreated: number;
    itemsUpdated: number;
    itemsUnchanged: number;
    warnings: RunWarning[];
}

/** Base class for Writer errors that map cleanly to HTTP responses. */
export class DatasetWriteError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    constructor(code: string, message: string, httpStatus: number) {
        super(message);
        this.name = "DatasetWriteError";
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** Existing dataset not found / not owned by the caller (§6.1: 404, never leak existence). */
export class DatasetNotFoundError extends DatasetWriteError {
    constructor(datasetId: string) {
        super("dataset_not_found", `Dataset not found: ${datasetId}`, 404);
        this.name = "DatasetNotFoundError";
    }
}

/** Existing dataset schema name/major disagrees with the producer mapping (409). */
export class DatasetSchemaMismatchError extends DatasetWriteError {
    constructor(expected: string, actual: string) {
        super(
            "dataset_schema_mismatch",
            `Dataset schema mismatch: expected ${expected}, dataset is ${actual}`,
            409
        );
        this.name = "DatasetSchemaMismatchError";
    }
}

/** Parsed + normalized `output.dataset` request config. */
export interface ParsedDatasetOutput {
    return: "result" | "items";
    dataset: DatasetTarget;
}

interface ItemCandidate {
    itemKey: string;
    sourceUrl: string | null;
    document: Record<string, unknown>;
}

interface MappedResult {
    candidates: ItemCandidate[];
    warnings: RunWarning[];
    /** Total candidates considered (including those skipped for a missing key). */
    seen: number;
}

type ItemClassification = "created" | "updated" | "unchanged" | "replayed" | "skipped";

/**
 * Result of a per-item upsert: how it was classified plus the uuid of the
 * dataset_items row it resolved to (null only when the item was skipped and no
 * row exists, e.g. an oversized document). The uuid is used to link the item
 * into dataset_run_items for per-run membership.
 */
interface UpsertOutcome {
    classification: ItemClassification;
    itemUuid: string | null;
}

export class DatasetWriter {
    // --- Static config helpers ----------------------------------------------

    /** Standard result→schema mapping for a built-in producer (§6.3 rule 9). */
    static standardMapping(scopeType: DatasetScopeType): DatasetMapping {
        switch (scopeType) {
            case "scrape":
                return { name: "anycrawl_scrape", version: "1.0.0" };
            case "crawl":
                return { name: "anycrawl_crawl_page", version: "1.0.0" };
            case "search":
                return { name: "anycrawl_search_result", version: "1.0.0" };
            case "orchestrated":
                // Default schema for orchestrated producers. Used only when the
                // caller does not override `mapping`; orchestrated producers
                // normally supply their own `itemsPath`/`itemKeyPath` (and often
                // a template-declared outputSchema name/version) via `mapping`.
                return { name: "anycrawl_orchestrated", version: "1.0.0" };
        }
    }

    /**
     * Parse the request `output` field into a normalized dataset config, or null
     * when no dataset write is requested (absent, or `mode: "none"`).
     */
    static parseOutput(
        rawOutput: unknown,
        opts: { defaultName: string }
    ): ParsedDatasetOutput | null {
        if (!rawOutput || typeof rawOutput !== "object") return null;
        const ds = (rawOutput as Record<string, unknown>).dataset;
        if (!ds || typeof ds !== "object") return null;
        const d = ds as Record<string, unknown>;
        if (d.mode === "none") return null;

        const ret = d.return === "items" ? "items" : "result";

        const datasetId = d.dataset_id;
        if (typeof datasetId === "string" && datasetId.trim().length > 0) {
            return { return: ret, dataset: { datasetId: datasetId.trim() } };
        }

        const name =
            typeof d.name === "string" && d.name.trim().length > 0
                ? d.name.trim()
                : opts.defaultName;
        const description = typeof d.description === "string" ? d.description : undefined;
        const retention =
            d.retention && typeof d.retention === "object"
                ? (d.retention as { item_days?: number; change_days?: number })
                : undefined;
        return {
            return: ret,
            dataset: { create: { name, description, retentionPolicy: retention ?? null } },
        };
    }

    // --- Eager (pre-job) validation -----------------------------------------

    /**
     * Validate that an EXISTING dataset is writable by this owner with this schema,
     * without performing any writes. Used by sync producers to surface a clean
     * 404/409 before the job runs. No-op for the create path.
     */
    static async assertDatasetWritable(params: {
        owner: OwnerContext;
        dataset: DatasetTarget;
        mapping: DatasetMapping;
        dbOrTx?: DBExecutor;
    }): Promise<void> {
        if ("create" in params.dataset) return;
        const db = params.dbOrTx ?? (await getDB());
        const row = await getOwnedDataset(db, params.dataset.datasetId, params.owner);
        if (!row) throw new DatasetNotFoundError(params.dataset.datasetId);
        this.assertSchemaCompatible(row, params.mapping);
    }

    private static assertSchemaCompatible(row: any, mapping: DatasetMapping): void {
        const major = (v: unknown) => String(v ?? "").split(".")[0];
        if (row.schemaName !== mapping.name || major(row.schemaVersion) !== major(mapping.version)) {
            throw new DatasetSchemaMismatchError(
                `${mapping.name}@${major(mapping.version)}.x`,
                `${row.schemaName}@${row.schemaVersion}`
            );
        }
    }

    // --- Main entry point ----------------------------------------------------

    /**
     * Persist a producer result into a dataset in a single transaction. Idempotent:
     * relies on uq_dataset_run_producer / uq_dataset_item / uq_dataset_change so
     * worker retries and duplicate messages never double-write.
     */
    static async writeResultToDataset(
        params: WriteResultToDatasetParams
    ): Promise<WriteResultToDatasetOutcome> {
        const now = params.now ?? new Date();
        const finalizeRun = params.finalizeRun !== false;

        return this.runInTransaction(params.dbOrTx, async (tx) => {
            // Step 1 — resolve or create the dataset.
            const dataset = await this.resolveDataset(tx, params, now);

            // Step 2 — get-or-create the dataset run (idempotent per producer).
            const run = await this.getOrCreateRun(tx, dataset, params, now);

            // Step 3 — map the result into item candidates.
            const mapped = this.mapResultToItems(params);
            const warnings: RunWarning[] = [...mapped.warnings];

            // Step 4 — per-item idempotent upsert.
            let created = 0;
            let updated = 0;
            let unchanged = 0;
            let skipped = 0;

            // 0-based index of the item within this write batch, recorded as the
            // run_item `position` for occurrence ordering. Incremented for every
            // candidate considered (including skipped ones) so it tracks arrival order.
            let position = 0;
            const pageIndex = Number.isInteger(params.pageIndex) ? (params.pageIndex as number) : 0;

            for (const candidate of mapped.candidates) {
                try {
                    const { classification, itemUuid } = await this.upsertItem(
                        tx,
                        dataset,
                        run,
                        candidate,
                        params,
                        now,
                        warnings
                    );
                    if (classification === "created") created++;
                    else if (classification === "updated") updated++;
                    else if (classification === "unchanged") unchanged++;
                    else if (classification === "skipped") skipped++;
                    // "replayed" → duplicate message, counted by neither branch.

                    // Record run membership for every item that resolved to a row
                    // (created/updated/unchanged/replayed alike — membership is
                    // independent of change). Skipped items have no row to link.
                    // onConflictDoNothing makes producer retries / duplicate pages
                    // side-effect-free on replay.
                    if (itemUuid) {
                        await this.insertRunItem(tx, run, itemUuid, candidate.itemKey, {
                            seedIndex: 0,
                            pageIndex,
                            position,
                        }, now);
                    }
                } catch (itemError) {
                    // Isolate a single bad item: record a warning, keep the run partial.
                    skipped++;
                    warnings.push({
                        code: "item_write_failed",
                        scope: "item",
                        itemKey: candidate.itemKey,
                        url: candidate.sourceUrl ?? undefined,
                        message: itemError instanceof Error ? itemError.message : String(itemError),
                    });
                } finally {
                    position++;
                }
            }

            // "Seen" counts every candidate considered — including those skipped
            // pre-loop for a missing key and in-loop for size / write failures.
            const seenDelta = mapped.seen;

            // Step 5 — bump dataset counters + run stats and (optionally) finalize.
            if (created > 0) {
                await tx
                    .update(schemas.datasets)
                    .set({
                        itemCount: sql`${schemas.datasets.itemCount} + ${created}`,
                        activeItemCount: sql`${schemas.datasets.activeItemCount} + ${created}`,
                        updatedAt: now,
                    })
                    .where(eq(schemas.datasets.uuid, dataset.uuid));
            }

            await this.persistWarnings(tx, run.uuid, warnings, now);

            const hadSkips = skipped > 0 || warnings.length > 0;
            const status: DatasetRunStatus = finalizeRun
                ? hadSkips
                    ? "partial"
                    : "completed"
                : "running";

            const mergedSummary = this.mergeWarningSummary(run.warningSummary, warnings);
            const runUpdate: Record<string, unknown> = {
                status,
                itemsSeen: sql`${schemas.datasetRuns.itemsSeen} + ${seenDelta}`,
                itemsCreated: sql`${schemas.datasetRuns.itemsCreated} + ${created}`,
                itemsUpdated: sql`${schemas.datasetRuns.itemsUpdated} + ${updated}`,
                itemsUnchanged: sql`${schemas.datasetRuns.itemsUnchanged} + ${unchanged}`,
                warningCount: sql`${schemas.datasetRuns.warningCount} + ${warnings.length}`,
                warningSummary: mergedSummary,
                updatedAt: now,
            };
            if (!run.startedAt) runUpdate.startedAt = now;
            if (finalizeRun) runUpdate.finishedAt = now;

            await tx
                .update(schemas.datasetRuns)
                .set(runUpdate)
                .where(eq(schemas.datasetRuns.uuid, run.uuid));

            // Step 6 — at finalize (scrape/search), assign a contiguous sequence
            // 1..N across this run's members. Non-finalized runs (crawl,
            // finalizeRun:false) keep sequence NULL and accumulate members per page;
            // a future crawl-finalize hook will assign sequence at the run's
            // terminal state. Guarded to be idempotent on replay.
            if (finalizeRun) {
                await this.assignRunItemSequences(tx, run.uuid);
            }

            return {
                datasetId: dataset.uuid,
                datasetRunId: run.uuid,
                status,
                itemsSeen: seenDelta,
                itemsCreated: created,
                itemsUpdated: updated,
                itemsUnchanged: unchanged,
                warnings,
            };
        });
    }

    /**
     * Finalize a crawl's accumulating dataset run at the crawl's terminal state.
     *
     * Crawl per-page writes use `finalizeRun:false`, so the run stays `running` and
     * its members keep `sequence` NULL while pages arrive (see writeResultToDataset
     * step 6). This is that crawl-finalize hook: called from the crawl's real
     * terminal point (ProgressManager.tryFinalize's winner branch and the auto-crawl
     * coordinator), it moves the run to a terminal status and assigns the contiguous
     * 1..N sequence across the run's members.
     *
     * The run is identified by (dataset_id, producer_type, producer_id) — the same
     * key getOrCreateRun used for every page. It is a safe no-op when:
     *   - no such run exists (a non-dataset crawl, or a crawl where no page ever
     *     wrote), or
     *   - the run is already terminal (idempotent on retry / double-finalize) —
     *     in which case it only re-asserts the sequence assignment (itself idempotent).
     *
     * Status mirrors the one-shot finalize: `partial` when any warnings were recorded
     * across the run's pages, otherwise `completed`. Per-item counters
     * (item_count/active_item_count) are maintained by the per-page writes, so there
     * is nothing to update here. Runs inside the caller's tx when supplied, else a
     * new transaction.
     */
    static async finalizeCrawlDatasetRun(params: {
        datasetId: string;
        producerId: string;
        producerType?: string;
        now?: Date;
        dbOrTx?: DBExecutor;
    }): Promise<{
        finalized: boolean;
        datasetRunId: string | null;
        status: DatasetRunStatus | null;
    }> {
        const now = params.now ?? new Date();
        const producerType = params.producerType ?? "crawl";

        return this.runInTransaction(params.dbOrTx, async (tx) => {
            const [run] = await tx
                .select()
                .from(schemas.datasetRuns)
                .where(
                    and(
                        eq(schemas.datasetRuns.datasetId, params.datasetId),
                        eq(schemas.datasetRuns.producerType, producerType),
                        eq(schemas.datasetRuns.producerId, params.producerId)
                    )
                )
                .limit(1);

            if (!run) {
                return { finalized: false, datasetRunId: null, status: null };
            }

            // Already terminal — idempotent no-op. Still re-assert the sequence
            // assignment so a finalize that crashed after the status update but
            // before sequencing converges on a later call.
            if (run.status !== "running") {
                await this.assignRunItemSequences(tx, run.uuid);
                return {
                    finalized: false,
                    datasetRunId: run.uuid,
                    status: run.status as DatasetRunStatus,
                };
            }

            const warningCount = Number(run.warningCount ?? 0);
            const status: DatasetRunStatus = warningCount > 0 ? "partial" : "completed";

            await tx
                .update(schemas.datasetRuns)
                .set({
                    status,
                    finishedAt: run.finishedAt ?? now,
                    updatedAt: now,
                })
                .where(eq(schemas.datasetRuns.uuid, run.uuid));

            await this.assignRunItemSequences(tx, run.uuid);

            return { finalized: true, datasetRunId: run.uuid, status };
        });
    }

    // --- Step 1: dataset resolution -----------------------------------------

    private static async resolveDataset(
        tx: DBExecutor,
        params: WriteResultToDatasetParams,
        now: Date
    ): Promise<any> {
        if ("datasetId" in params.dataset) {
            const row = await getOwnedDataset(tx, params.dataset.datasetId, params.owner);
            if (!row) throw new DatasetNotFoundError(params.dataset.datasetId);
            this.assertSchemaCompatible(row, params.mapping);
            return row;
        }

        const spec = params.dataset.create;
        const [row] = await tx
            .insert(schemas.datasets)
            .values({
                apiKey: params.owner.apiKeyId ?? null,
                userId: params.owner.userId ?? null,
                name: spec.name,
                description: spec.description ?? null,
                sourceType: params.scopeType,
                schemaName: params.mapping.name,
                schemaVersion: params.mapping.version,
                retentionPolicy: spec.retentionPolicy ?? null,
                createdAt: now,
                updatedAt: now,
            })
            .returning();
        return row;
    }

    // --- Step 2: run get-or-create ------------------------------------------

    private static async getOrCreateRun(
        tx: DBExecutor,
        dataset: any,
        params: WriteResultToDatasetParams,
        now: Date
    ): Promise<any> {
        const scopeKey = `job:${params.scope.jobId}`;
        const [inserted] = await tx
            .insert(schemas.datasetRuns)
            .values({
                datasetId: dataset.uuid,
                producerType: params.producerType,
                producerId: params.producerId,
                scopeKey,
                status: "running",
                coverageComplete: false,
                startedAt: now,
                createdAt: now,
                updatedAt: now,
            })
            .onConflictDoNothing({
                target: [
                    schemas.datasetRuns.datasetId,
                    schemas.datasetRuns.producerType,
                    schemas.datasetRuns.producerId,
                ],
            })
            .returning();

        if (inserted) return inserted;

        // Concurrent/retry insert lost the race — re-select the existing run.
        const [existing] = await tx
            .select()
            .from(schemas.datasetRuns)
            .where(
                and(
                    eq(schemas.datasetRuns.datasetId, dataset.uuid),
                    eq(schemas.datasetRuns.producerType, params.producerType),
                    eq(schemas.datasetRuns.producerId, params.producerId)
                )
            )
            .limit(1);
        if (!existing) {
            throw new DatasetWriteError(
                "dataset_run_unavailable",
                "Failed to get-or-create dataset run",
                500
            );
        }
        return existing;
    }

    // --- Step 3: result → items ---------------------------------------------

    private static mapResultToItems(params: WriteResultToDatasetParams): MappedResult {
        const { scopeType, mapping, result } = params;

        // Custom split via itemsPath/itemKeyPath (§6.3 rule 8).
        if (mapping.itemsPath) {
            const arr = this.getPath(result, mapping.itemsPath);
            const candidates: ItemCandidate[] = [];
            const warnings: RunWarning[] = [];
            const list = Array.isArray(arr) ? arr : [];
            for (const entry of list) {
                const key = mapping.itemKeyPath
                    ? this.getPath(entry, mapping.itemKeyPath)
                    : undefined;
                const itemKey = this.stableKey(key);
                if (!itemKey) {
                    warnings.push({ code: "missing_item_key", scope: "item" });
                    continue;
                }
                candidates.push({
                    itemKey,
                    sourceUrl: this.readUrl(entry),
                    document: this.asDocument(entry),
                });
            }
            return { candidates, warnings, seen: list.length };
        }

        if (scopeType === "search") {
            // The search response is the array of results (each = 1 item).
            const results = this.extractSearchResults(result);
            const candidates: ItemCandidate[] = [];
            const warnings: RunWarning[] = [];
            for (const entry of results) {
                const url = this.readUrl(entry);
                if (!url) {
                    warnings.push({ code: "missing_item_key", scope: "item" });
                    continue;
                }
                candidates.push({
                    itemKey: this.normalizeUrl(url),
                    sourceUrl: url,
                    document: this.asDocument(entry),
                });
            }
            return { candidates, warnings, seen: results.length };
        }

        // scrape / crawl: the whole page is one item keyed by its normalized URL.
        const url = this.readUrl(result);
        if (!url) {
            return {
                candidates: [],
                warnings: [{ code: "missing_item_key", scope: "item" }],
                seen: 1,
            };
        }
        return {
            candidates: [
                {
                    itemKey: this.normalizeUrl(url),
                    sourceUrl: url,
                    document: this.asDocument(result),
                },
            ],
            warnings: [],
            seen: 1,
        };
    }

    // --- Step 4: per-item upsert --------------------------------------------

    private static async upsertItem(
        tx: DBExecutor,
        dataset: any,
        run: any,
        candidate: ItemCandidate,
        params: WriteResultToDatasetParams,
        now: Date,
        warnings: RunWarning[]
    ): Promise<UpsertOutcome> {
        const document = candidate.document;

        // Size guard — skip oversized normalized documents, never truncate.
        const byteLength = Buffer.byteLength(JSON.stringify(document ?? {}), "utf8");
        if (byteLength > MAX_ITEM_BYTES) {
            warnings.push({
                code: "item_too_large",
                scope: "item",
                itemKey: candidate.itemKey,
                url: candidate.sourceUrl ?? undefined,
                message: `Normalized document ${byteLength} bytes exceeds ${MAX_ITEM_BYTES}`,
            });
            return { classification: "skipped", itemUuid: null };
        }

        const excludePaths = [
            ...PLATFORM_HASH_EXCLUDE_PATHS,
            ...(params.mapping.hashExcludePaths ?? []),
        ];
        const newHash = computeDocumentHash(document, excludePaths);

        const [existing] = await tx
            .select()
            .from(schemas.datasetItems)
            .where(
                and(
                    eq(schemas.datasetItems.datasetId, dataset.uuid),
                    eq(schemas.datasetItems.itemKey, candidate.itemKey)
                )
            )
            .limit(1);

        if (!existing) {
            const [insertedItem] = await tx
                .insert(schemas.datasetItems)
                .values({
                    datasetId: dataset.uuid,
                    itemKey: candidate.itemKey,
                    sourceType: params.scopeType,
                    sourceUrl: candidate.sourceUrl ?? null,
                    document,
                    documentHash: newHash,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    isActive: true,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoNothing({
                    target: [schemas.datasetItems.datasetId, schemas.datasetItems.itemKey],
                })
                .returning();

            if (insertedItem) {
                const changeInserted = await this.insertChange(tx, {
                    dataset,
                    run,
                    itemUuid: insertedItem.uuid,
                    itemKey: candidate.itemKey,
                    changeType: "created",
                    beforeHash: null,
                    afterHash: newHash,
                    fieldChanges: null,
                    now,
                });
                await this.writeProjections(tx, dataset.uuid, candidate, params, now);
                return {
                    classification: changeInserted ? "created" : "replayed",
                    itemUuid: insertedItem.uuid,
                };
            }

            // Lost an insert race — fall through to the update path with the row now present.
            const [row] = await tx
                .select()
                .from(schemas.datasetItems)
                .where(
                    and(
                        eq(schemas.datasetItems.datasetId, dataset.uuid),
                        eq(schemas.datasetItems.itemKey, candidate.itemKey)
                    )
                )
                .limit(1);
            return this.applyExisting(tx, dataset, run, row, candidate, params, now, newHash);
        }

        return this.applyExisting(tx, dataset, run, existing, candidate, params, now, newHash);
    }

    private static async applyExisting(
        tx: DBExecutor,
        dataset: any,
        run: any,
        existing: any,
        candidate: ItemCandidate,
        params: WriteResultToDatasetParams,
        now: Date,
        newHash: string
    ): Promise<UpsertOutcome> {
        if (existing.documentHash === newHash) {
            // Unchanged: bump last_seen_at only, no change record (§12 rule 5).
            await tx
                .update(schemas.datasetItems)
                .set({ lastSeenAt: now, isActive: true, updatedAt: now })
                .where(eq(schemas.datasetItems.uuid, existing.uuid));

            // Replay guard: if this run already logged a change for this item, the
            // message is a duplicate — do not double-count it as "unchanged".
            const alreadyTouched = await this.runHasChangeForItem(tx, run.uuid, candidate.itemKey);
            return {
                classification: alreadyTouched ? "replayed" : "unchanged",
                itemUuid: existing.uuid,
            };
        }

        // Changed: replace document + hash, record an "updated" change.
        const fieldChanges = shallowFieldDiff(existing.document, candidate.document);
        await tx
            .update(schemas.datasetItems)
            .set({
                document: candidate.document,
                documentHash: newHash,
                sourceUrl: candidate.sourceUrl ?? existing.sourceUrl ?? null,
                lastSeenAt: now,
                isActive: true,
                updatedAt: now,
            })
            .where(eq(schemas.datasetItems.uuid, existing.uuid));

        const changeInserted = await this.insertChange(tx, {
            dataset,
            run,
            itemUuid: existing.uuid,
            itemKey: candidate.itemKey,
            changeType: "updated",
            beforeHash: existing.documentHash,
            afterHash: newHash,
            fieldChanges: Object.keys(fieldChanges).length > 0 ? fieldChanges : null,
            now,
        });
        await this.writeProjections(tx, dataset.uuid, candidate, params, now);
        return {
            classification: changeInserted ? "updated" : "replayed",
            itemUuid: existing.uuid,
        };
    }

    /** Insert a change row idempotently. Returns true iff a new row was written. */
    private static async insertChange(
        tx: DBExecutor,
        args: {
            dataset: any;
            run: any;
            itemUuid: string;
            itemKey: string;
            changeType: "created" | "updated" | "removed";
            beforeHash: string | null;
            afterHash: string | null;
            fieldChanges: Record<string, { before: unknown; after: unknown }> | null;
            now: Date;
        }
    ): Promise<boolean> {
        const [row] = await tx
            .insert(schemas.datasetItemChanges)
            .values({
                datasetId: args.dataset.uuid,
                datasetRunId: args.run.uuid,
                datasetItemId: args.itemUuid,
                itemKey: args.itemKey,
                scopeKey: args.run.scopeKey,
                changeType: args.changeType,
                beforeHash: args.beforeHash,
                afterHash: args.afterHash,
                fieldChanges: args.fieldChanges,
                createdAt: args.now,
            })
            .onConflictDoNothing({
                target: [
                    schemas.datasetItemChanges.datasetRunId,
                    schemas.datasetItemChanges.itemKey,
                    schemas.datasetItemChanges.changeType,
                ],
            })
            .returning({ uuid: schemas.datasetItemChanges.uuid });
        return !!row;
    }

    private static async runHasChangeForItem(
        tx: DBExecutor,
        runId: string,
        itemKey: string
    ): Promise<boolean> {
        const [row] = await tx
            .select({ uuid: schemas.datasetItemChanges.uuid })
            .from(schemas.datasetItemChanges)
            .where(
                and(
                    eq(schemas.datasetItemChanges.datasetRunId, runId),
                    eq(schemas.datasetItemChanges.itemKey, itemKey)
                )
            )
            .limit(1);
        return !!row;
    }

    // --- Step 5: run membership (dataset_run_items) -------------------------

    /**
     * Link an item into the run's membership set. `sequence` is left NULL here and
     * assigned only when the run is finalized (see assignRunItemSequences). The
     * onConflictDoNothing on (dataset_run_id, item_key) makes this a no-op on
     * producer retries and duplicate pages, so replays never double-insert.
     */
    private static async insertRunItem(
        tx: DBExecutor,
        run: any,
        itemUuid: string,
        itemKey: string,
        occurrence: { seedIndex: number; pageIndex: number; position: number },
        now: Date
    ): Promise<void> {
        await tx
            .insert(schemas.datasetRunItems)
            .values({
                datasetRunId: run.uuid,
                datasetItemId: itemUuid,
                itemKey,
                sequence: null,
                // Standard producers have no per-seed fan-out (§ one-shot job scope):
                // seedKey stays null and seedIndex is 0.
                seedKey: null,
                seedIndex: occurrence.seedIndex,
                pageIndex: occurrence.pageIndex,
                position: occurrence.position,
                createdAt: now,
            })
            .onConflictDoNothing({
                target: [schemas.datasetRunItems.datasetRunId, schemas.datasetRunItems.itemKey],
            });
    }

    /**
     * Assign a contiguous sequence (1..N) to a finalized run's members, ordered by
     * (seed_index, page_index, position, created_at, uuid). Idempotent: if every
     * member already has a sequence (a replay of an already-finalized run), it is a
     * no-op. Otherwise it clears sequences to NULL first, then reassigns from an
     * all-NULL base — so per-row assignment can never transiently violate the
     * partial unique(dataset_run_id, sequence) constraint in either dialect.
     */
    private static async assignRunItemSequences(tx: DBExecutor, runId: string): Promise<void> {
        const rows = await tx
            .select({
                uuid: schemas.datasetRunItems.uuid,
                sequence: schemas.datasetRunItems.sequence,
            })
            .from(schemas.datasetRunItems)
            .where(eq(schemas.datasetRunItems.datasetRunId, runId))
            .orderBy(
                sql`${schemas.datasetRunItems.seedIndex} ASC,
                    ${schemas.datasetRunItems.pageIndex} ASC,
                    ${schemas.datasetRunItems.position} ASC,
                    ${schemas.datasetRunItems.createdAt} ASC,
                    ${schemas.datasetRunItems.uuid} ASC`
            );

        if (rows.length === 0) return;

        // Idempotency guard: nothing to do if the run is already fully sequenced.
        const hasUnassigned = rows.some((r: any) => r.sequence === null || r.sequence === undefined);
        if (!hasUnassigned) return;

        // Reset to an all-NULL base so the reassignment below cannot collide with a
        // value some other row currently holds under the partial-unique index.
        await tx
            .update(schemas.datasetRunItems)
            .set({ sequence: null })
            .where(eq(schemas.datasetRunItems.datasetRunId, runId));

        let seq = 1;
        for (const r of rows) {
            await tx
                .update(schemas.datasetRunItems)
                .set({ sequence: seq })
                .where(eq(schemas.datasetRunItems.uuid, r.uuid));
            seq++;
        }
    }

    // --- Optional projections (dataset_item_field_values) -------------------

    private static async writeProjections(
        tx: DBExecutor,
        datasetId: string,
        candidate: ItemCandidate,
        params: WriteResultToDatasetParams,
        now: Date
    ): Promise<void> {
        const projections = params.mapping.projections;
        if (!projections || projections.length === 0) return;

        for (const proj of projections) {
            const raw = this.getPath(candidate.document, proj.path);
            const typed = this.coerceProjection(proj.type, raw);
            if (typed === undefined) continue; // unresolvable / wrong type → skip silently

            await tx
                .insert(schemas.datasetItemFieldValues)
                .values({
                    datasetId,
                    itemKey: candidate.itemKey,
                    fieldName: proj.name,
                    fieldType: proj.type,
                    stringValue: proj.type === "string" ? (typed as string) : null,
                    numberValue: proj.type === "number" ? (typed as any) : null,
                    booleanValue: proj.type === "boolean" ? (typed as boolean) : null,
                    timestamptzValue: proj.type === "timestamptz" ? (typed as Date) : null,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoUpdate({
                    target: [
                        schemas.datasetItemFieldValues.datasetId,
                        schemas.datasetItemFieldValues.itemKey,
                        schemas.datasetItemFieldValues.fieldName,
                    ],
                    set: {
                        fieldType: proj.type,
                        stringValue: proj.type === "string" ? (typed as string) : null,
                        numberValue: proj.type === "number" ? (typed as any) : null,
                        booleanValue: proj.type === "boolean" ? (typed as boolean) : null,
                        timestamptzValue: proj.type === "timestamptz" ? (typed as Date) : null,
                        updatedAt: now,
                    },
                });
        }
    }

    private static coerceProjection(
        type: DatasetProjectionSpec["type"],
        raw: unknown
    ): string | number | boolean | Date | undefined {
        if (raw === null || raw === undefined) return undefined;
        switch (type) {
            case "string":
                return typeof raw === "object" ? undefined : String(raw);
            case "number": {
                const n = Number(raw);
                return Number.isFinite(n) ? n : undefined;
            }
            case "boolean":
                if (typeof raw === "boolean") return raw;
                if (raw === "true" || raw === 1) return true;
                if (raw === "false" || raw === 0) return false;
                return undefined;
            case "timestamptz": {
                const d = raw instanceof Date ? raw : new Date(String(raw));
                return Number.isNaN(d.getTime()) ? undefined : d;
            }
        }
    }

    // --- Warnings persistence ------------------------------------------------

    private static async persistWarnings(
        tx: DBExecutor,
        runId: string,
        warnings: RunWarning[],
        now: Date
    ): Promise<void> {
        if (warnings.length === 0) return;
        const rows = warnings.map((w) => ({
            datasetRunId: runId,
            scope: w.scope ?? "run",
            code: w.code,
            message: w.message ?? null,
            itemKey: w.itemKey ?? null,
            url: w.url ?? null,
            createdAt: now,
        }));
        await tx.insert(schemas.runWarnings).values(rows);
    }

    private static mergeWarningSummary(
        existing: Array<{ code: string; count: number }> | null | undefined,
        warnings: RunWarning[]
    ): Array<{ code: string; count: number }> {
        const counts = new Map<string, number>();
        for (const entry of existing ?? []) {
            counts.set(entry.code, (counts.get(entry.code) ?? 0) + entry.count);
        }
        for (const w of warnings) {
            counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
        }
        return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
    }

    // --- Small utilities -----------------------------------------------------

    private static runInTransaction<T>(
        dbOrTx: DBExecutor | undefined,
        work: (tx: DBExecutor) => Promise<T>
    ): Promise<T> {
        if (dbOrTx) return work(dbOrTx);
        return getDB().then((db) => db.transaction((tx: DBExecutor) => work(tx)));
    }

    /** Mirror of libs `normalizeUrl` (kept local so packages/db stays self-contained). */
    private static normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            parsed.hostname = parsed.hostname.toLowerCase();
            if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
                parsed.pathname = parsed.pathname.slice(0, -1);
            }
            const tracking = [
                "utm_source",
                "utm_medium",
                "utm_campaign",
                "utm_term",
                "utm_content",
                "fbclid",
                "gclid",
            ];
            tracking.forEach((p) => parsed.searchParams.delete(p));
            parsed.searchParams.sort();
            return parsed.toString();
        } catch {
            return url;
        }
    }

    private static readUrl(entry: unknown): string | null {
        if (!entry || typeof entry !== "object") return null;
        const url = (entry as Record<string, unknown>).url;
        return typeof url === "string" && url.length > 0 ? url : null;
    }

    private static asDocument(entry: unknown): Record<string, unknown> {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            return entry as Record<string, unknown>;
        }
        return { value: entry } as Record<string, unknown>;
    }

    private static stableKey(value: unknown): string | null {
        if (value === null || value === undefined) return null;
        if (typeof value === "string") return value.length > 0 ? value : null;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        return null;
    }

    /** Extract the search results array from various search response shapes. */
    private static extractSearchResults(result: unknown): unknown[] {
        if (Array.isArray(result)) return result;
        if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (Array.isArray(r.results)) return r.results;
            if (Array.isArray(r.data)) return r.data;
        }
        return [];
    }

    /**
     * Resolve an RFC 6901 JSON pointer ("/a/b" or the shorthand "a") against a
     * value. Reference tokens are unescaped per RFC 6901 (`~1` -> `/`, `~0` -> `~`,
     * in that order) so field names that contain `/` or `~` resolve correctly.
     */
    private static getPath(source: unknown, path: string): unknown {
        const segments = String(path)
            .split("/")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
        let node: any = source;
        for (const seg of segments) {
            if (node === null || typeof node !== "object") return undefined;
            node = node[seg];
        }
        return node;
    }
}

export const writeResultToDataset = DatasetWriter.writeResultToDataset.bind(DatasetWriter);
