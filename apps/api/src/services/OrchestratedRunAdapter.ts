import { RequestWithAuth, log, type OwnerContext } from "@anycrawl/libs";
import {
    appendTemplateRunEvent,
    updateTemplateRunStatus,
    finalizeTemplateRun,
    parseDatasetOutput,
    assertDatasetWritable,
    DatasetWriteError,
    type DatasetMapping,
} from "@anycrawl/db";
import { QueueManager, type TemplateRunJobPayload } from "@anycrawl/scrape";

/**
 * Orchestrated Run Adapter (design doc §7 / L3 Phase 4).
 *
 * Symmetric to the LegacyRunAdapter, but for `runtime.mode = "orchestrated"`
 * templates: instead of driving the legacy scrape/search/crawl chain, it resolves
 * the per-item Dataset destination from the template's declared `outputSchema`,
 * validates it eagerly (clean 404/409 before enqueue), then enqueues the run onto
 * the engine-independent `template-run` queue for the OrchestratedRunner worker.
 *
 * The run row is created by the controller BEFORE this adapter runs, so any failure
 * here finalizes the run `failed` rather than leaving it lingering in `queued`.
 * On success the run is bound to the BullMQ job id and moved to `running` (202),
 * mirroring LegacyRunAdapter.startCrawlRun.
 */

export interface StartOrchestratedRunParams {
    /** The persisted `template_runs` row (queued, mode "orchestrated"). */
    run: any;
    /** Resolved template (TemplateConfig) — supplies uuid, reqOptions, outputSchema. */
    template: any;
    /** The frozen revision this run reproduces (supplies uuid + schemaSnapshot). */
    revision: any;
    /** Merged + defaulted variables the seed/page handlers consume. */
    variables: Record<string, any>;
    /** Run-scoped option overrides (bounded by platform hard caps in the worker). */
    runOptions?: Record<string, unknown> | null;
    /** The raw request `output` field, parsed into a dataset destination. */
    rawOutput?: unknown;
    /** The live Express request (carries auth → owner context). */
    req: RequestWithAuth;
}

export interface StartOrchestratedRunResult {
    ok: boolean;
    httpStatus: number;
    /** The BullMQ job id (== runId) when enqueued. */
    bullJobId: string | null;
    /** Bound existing dataset id when the destination is an existing dataset. */
    datasetId: string | null;
    /** Error envelope `{ error, message }` when `ok` is false. */
    errorBody?: { error: string; message: string };
}

export class OrchestratedRunAdapter {
    /**
     * Resolve the dataset destination + engine and enqueue an orchestrated Template
     * Run. Returns 202 (running) on success, a clean 400/404/409 for
     * schema/dataset problems, or 500 on an unexpected enqueue failure — the run is
     * finalized `failed` in every non-ok case so it never stays `queued`.
     */
    public startOrchestratedRun = async (
        params: StartOrchestratedRunParams
    ): Promise<StartOrchestratedRunResult> => {
        const { run, template, revision, variables, runOptions, rawOutput, req } = params;
        const owner: OwnerContext = { apiKeyId: req.auth?.uuid, userId: req.auth?.user };

        try {
            if (!revision?.uuid) {
                return this.fail(
                    run.uuid,
                    500,
                    "template_revision_missing",
                    "Failed to freeze a template revision for this run"
                );
            }

            // 1) Orchestrated runs REQUIRE a structured output schema. Prefer the
            //    frozen revision snapshot, then the live config / metadata.
            const outputSchema =
                (revision as any)?.schemaSnapshot ??
                (template as any)?.outputSchema ??
                (template as any)?.metadata?.outputSchema ??
                null;
            if (!outputSchema || typeof outputSchema !== "object" || !(outputSchema as any).name) {
                return this.fail(
                    run.uuid,
                    400,
                    "output_schema_required",
                    "Orchestrated templates require an outputSchema to write results"
                );
            }

            // 2) Build the per-item Dataset mapping from the output schema.
            const mapping = this.buildMapping(outputSchema);

            // 3) Resolve the dataset destination (existing id, or create-on-first-write).
            //    Absent/`none` output still needs a home for the streamed items, so we
            //    default to creating a dataset named after the schema.
            const defaultName = String((outputSchema as any).name);
            const dataset =
                parseDatasetOutput(rawOutput, { defaultName })?.dataset ??
                { create: { name: defaultName, retentionPolicy: null } };

            // Eager validation: no-op for the create path; 404/409 for a
            // non-writable / schema-mismatched existing dataset.
            try {
                await assertDatasetWritable({ owner, dataset, mapping });
            } catch (dsError) {
                if (dsError instanceof DatasetWriteError) {
                    return this.fail(run.uuid, dsError.httpStatus, dsError.code, dsError.message);
                }
                throw dsError;
            }

            const existingDatasetId = "datasetId" in dataset ? dataset.datasetId : null;
            const datasetTarget =
                "datasetId" in dataset
                    ? { datasetId: dataset.datasetId, mapping, owner }
                    : { create: dataset.create, mapping, owner };

            // 4) Engine from the template reqOptions (default cheerio).
            const engine = String((template as any)?.reqOptions?.engine ?? "cheerio");

            // 5) Enqueue onto the `template-run` queue (stable jobId == runId).
            const payload: TemplateRunJobPayload = {
                type: "template-run",
                runId: run.uuid,
                templateRevisionId: revision.uuid,
                templateUuid: template.uuid,
                variables: variables ?? {},
                runOptions: (runOptions as Record<string, any>) ?? undefined,
                dataset: datasetTarget,
                engine,
                ownerContext: owner,
            };
            const bullJobId = await QueueManager.getInstance().addTemplateRunJob(payload);

            // 6) Record dispatch + move the run to running (mirror startCrawlRun).
            await appendTemplateRunEvent(run.uuid, "run_dispatched", { mode: "orchestrated" });
            await updateTemplateRunStatus(run.uuid, {
                status: "running",
                legacyJobUuid: bullJobId,
                datasetId: existingDatasetId ?? undefined,
                startedAt: new Date(),
            });
            await appendTemplateRunEvent(run.uuid, "run_running", {
                legacy_job_id: bullJobId,
                engine,
            });

            return { ok: true, httpStatus: 202, bullJobId, datasetId: existingDatasetId };
        } catch (error) {
            // Any failure after the run row exists must not leave it `queued`.
            const message = error instanceof Error ? error.message : String(error);
            log.error(`[ORCHESTRATED-RUN] dispatch failed for ${run.uuid}: ${message}`);
            await this.finalizeFailed(run.uuid, "dispatch_failed", message);
            return {
                ok: false,
                httpStatus: 500,
                bullJobId: null,
                datasetId: null,
                errorBody: { error: "dispatch_failed", message },
            };
        }
    };

    /** Map a template `outputSchema` onto the Dataset Writer's mapping shape. */
    private buildMapping(schema: any): DatasetMapping {
        const projections = Array.isArray(schema.projections)
            ? schema.projections
                .filter((p: any) => p && typeof p.path === "string")
                .map((p: any) => ({
                    // outputSchema projections use `field`; DatasetMapping uses `name`.
                    name: String(p.field ?? p.name),
                    path: String(p.path),
                    type: p.type ?? "string",
                }))
            : undefined;
        return {
            name: String(schema.name),
            version: String(schema.version ?? "1.0.0"),
            itemsPath: typeof schema.itemsPath === "string" ? schema.itemsPath : "/items",
            itemKeyPath: typeof schema.itemKeyPath === "string" ? schema.itemKeyPath : "/itemKey",
            hashExcludePaths: Array.isArray(schema.hashExcludePaths)
                ? schema.hashExcludePaths
                : undefined,
            projections,
        };
    }

    /** Finalize the run failed and return the error result envelope. */
    private async fail(
        runId: string,
        httpStatus: number,
        code: string,
        message: string
    ): Promise<StartOrchestratedRunResult> {
        await this.finalizeFailed(runId, code, message);
        return {
            ok: false,
            httpStatus,
            bullJobId: null,
            datasetId: null,
            errorBody: { error: code, message },
        };
    }

    /** Move a lingering `queued` run to a terminal `failed` state (best-effort). */
    private async finalizeFailed(
        runId: string,
        errorCode: string,
        errorMessage: string
    ): Promise<void> {
        try {
            await appendTemplateRunEvent(runId, "run_failed", {
                error: errorCode,
                message: errorMessage,
            });
            await finalizeTemplateRun(runId, "failed", {
                stopReason: "failed",
                errorCode,
                errorMessage,
                finishedAt: new Date(),
            });
        } catch (e) {
            log.warning(
                `[ORCHESTRATED-RUN] failed to finalize run ${runId} as failed: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
}
