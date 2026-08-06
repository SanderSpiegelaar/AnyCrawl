import { Response } from "express";
import { z } from "zod";
import { RequestWithAuth, type OwnerContext, log } from "@anycrawl/libs";
import {
    getDB,
    resolveTemplateByRef,
    freezeCurrentTemplateRevision,
    createTemplateRun,
    getTemplateRun,
    getTemplateRunByIdempotency,
    getOwnedTemplateRun,
    listTemplateRunsByOwner,
    listTemplateRunEvents,
    listTemplateRunWarnings,
    requestTemplateRunCancel,
    finalizeTemplateRun,
    getJob,
    computeDocumentHash,
    STATUS,
    TEMPLATE_RUN_TERMINAL_STATUSES,
} from "@anycrawl/db";
import { TemplateHandler } from "../../utils/templateHandler.js";
import { LegacyRunAdapter } from "../../services/LegacyRunAdapter.js";
import { serializeRecords } from "../../utils/serializer.js";
import { encodeCursor, decodeCursor, InvalidCursorError, type Cursor } from "../../utils/cursor.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

/**
 * Body accepted by `POST /v1/template/{ref}/runs`. Kept intentionally lenient
 * (passthrough): the deep validation of variables, domain restrictions and the
 * producer schema is performed by `mergeRequestWithTemplate` + the delegated
 * legacy controller, exactly as a body `template_id` call. This schema only
 * type-checks the top-level run envelope (design doc §6.2 create example).
 */
const runCreateSchema = z
    .object({
        template_id: z.string().optional(),
        variables: z.record(z.any()).optional(),
        url: z.string().optional(),
        query: z.string().optional(),
        run_options: z.record(z.any()).optional(),
        output: z.object({ dataset: z.any().optional() }).passthrough().optional(),
        delivery: z.any().optional(),
    })
    .passthrough();

/**
 * Template Run Core API (design doc §6.2 / §7.1).
 *
 * Owns the unified async Run lifecycle for a Template — create (idempotent),
 * list, get, cancel, and the events / warnings / dataset feeds — all nested
 * under the template resource:
 *
 *   POST /v1/template/{ref}/runs
 *   GET  /v1/template/{ref}/runs
 *   GET  /v1/template/{ref}/runs/{run_id}
 *   POST /v1/template/{ref}/runs/{run_id}/cancel
 *   GET  /v1/template/{ref}/runs/{run_id}/events
 *   GET  /v1/template/{ref}/runs/{run_id}/warnings
 *   GET  /v1/template/{ref}/runs/{run_id}/dataset
 *
 * `create` never re-implements variable merging, validation, handlers or billing:
 * it freezes the current revision, snapshots the input, persists a `template_runs`
 * row, then drives the LegacyRunAdapter (which delegates to the existing
 * scrape/search/crawl controllers). `runtime.mode="orchestrated"` templates are
 * rejected 501 until Phase 4 — no lingering run is created (see `create`).
 */
export class TemplateRunController {
    private readonly adapter = new LegacyRunAdapter();

    // --- Create --------------------------------------------------------------

    /** POST /v1/template/{ref}/runs */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const ref = req.params.templateRef ?? "";
            if (!ref) {
                this.notFound(res, "template_not_found", `Template not found: ${ref}`);
                return;
            }

            const template = await resolveTemplateByRef(ref);
            if (!template) {
                this.notFound(res, "template_not_found", `Template not found: ${ref}`);
                return;
            }

            if (!TemplateHandler.hasTemplateAccess(template, this.currentUserId(req))) {
                this.forbidden(res);
                return;
            }

            // Orchestrated runtime is Phase 4. Reject BEFORE creating any row so no
            // lingering/failed run is left behind (choice: fail-fast, no side effects).
            if ((template as any).runtime?.mode === "orchestrated") {
                res.status(501).json({
                    success: false,
                    error: "not_implemented",
                    message: "orchestrated runs land in Phase 4",
                });
                return;
            }

            const type = template.templateType; // "scrape" | "crawl" | "search"
            if (type !== "scrape" && type !== "crawl" && type !== "search") {
                this.badRequest(res, "Validation error", `Unsupported template type: ${type}`);
                return;
            }

            const body = runCreateSchema.parse(req.body ?? {});

            // Lightweight url|query presence check. Variables may satisfy the target
            // via mapping, so only fail when neither the field nor variables are given.
            if (type === "search") {
                if (!body.query && !body.variables) {
                    this.badRequest(res, "invalid_url", "A `query` (or `variables`) is required");
                    return;
                }
            } else if (!body.url && !body.variables) {
                this.badRequest(res, "invalid_url", "A `url` (or `variables`) is required");
                return;
            }

            const idempotencyKey = this.idempotencyKey(req);

            // Freeze the current revision so the run reproduces this exact config even
            // if the template is later edited (design doc §7.1 step 1 / §9.1).
            const revision = await freezeCurrentTemplateRevision(template.templateId);

            // The raw body a `template_id` call accepts. The adapter re-merges via the
            // delegated controller, so we pass this UN-merged (avoids a double-merge).
            const delegatedBody: Record<string, unknown> = {
                ...(req.body as Record<string, unknown>),
                template_id: template.templateId,
            };

            // Pre-flight validation: merge variables + domain/keyword restrictions.
            // Throws on invalid variables / disallowed URL — mapped to 400 below.
            try {
                await TemplateHandler.mergeRequestWithTemplate(
                    { ...delegatedBody },
                    type,
                    this.currentUserId(req)
                );
            } catch (mergeError) {
                this.mergeValidationError(res, mergeError);
                return;
            }

            // Immutable input snapshot + normalized hash for idempotency conflict checks.
            const inputSnapshot = this.buildInputSnapshot(body);
            const normalizedInputHash = computeDocumentHash(inputSnapshot);

            const owner = this.getOwner(req);
            let idempotencyScopeHash: string | null = null;
            if (idempotencyKey) {
                idempotencyScopeHash = computeDocumentHash({
                    owner: owner.userId ?? owner.apiKeyId ?? null,
                    template: template.uuid,
                    key: idempotencyKey,
                });

                // Same Owner+Template+Key: return the original run (200). A different
                // normalized input under the same key is a conflict (§6.2 rule 9).
                const existing = await getTemplateRunByIdempotency(template.uuid, idempotencyScopeHash);
                if (existing) {
                    if (
                        existing.normalizedInputHash &&
                        existing.normalizedInputHash !== normalizedInputHash
                    ) {
                        res.status(409).json({
                            success: false,
                            error: "idempotency_conflict",
                            message:
                                "This Idempotency-Key was already used with a different request payload",
                        });
                        return;
                    }
                    res.status(200).json({
                        success: true,
                        data: this.formatRun(existing, ref, template.templateId),
                    });
                    return;
                }
            }

            const run = await createTemplateRun({
                apiKeyId: owner.apiKeyId ?? null,
                userId: owner.userId ?? null,
                templateUuid: template.uuid,
                templateRevisionUuid: revision?.uuid ?? null,
                mode: "single",
                status: "queued",
                idempotencyScopeHash,
                inputSnapshot,
                normalizedInputHash,
                runOptions: (body.run_options as Record<string, unknown>) ?? null,
            });

            if (!run) {
                this.internalError(res, new Error("Failed to create template run"));
                return;
            }

            // Dispatch by producer type. scrape/search run synchronously (run-sync
            // semantics) → terminal run (201); crawl enqueues async → running (202).
            if (type === "crawl") {
                const outcome = await this.adapter.startCrawlRun({
                    run,
                    template,
                    delegatedBody,
                    req,
                });
                const finalRun = (await getTemplateRun(run.uuid)) ?? run;
                const httpStatus = outcome.ok ? 202 : outcome.httpStatus || 500;
                res.status(httpStatus).json({
                    success: outcome.ok,
                    data: this.formatRun(finalRun, ref, template.templateId, {
                        dataset_id: outcome.datasetId ?? finalRun.datasetId ?? null,
                    }),
                    ...(outcome.ok ? {} : { error: this.producerError(outcome.body) }),
                });
                return;
            }

            const outcome = await this.adapter.executeSingleRun({
                run,
                template,
                delegatedBody,
                req,
            });
            const finalRun = (await getTemplateRun(run.uuid)) ?? run;
            const httpStatus = outcome.ok ? 201 : outcome.httpStatus || 500;
            res.status(httpStatus).json({
                success: outcome.ok,
                data: this.formatRun(finalRun, ref, template.templateId, {
                    result: outcome.result ?? null,
                    dataset: outcome.datasetOutcome ?? null,
                }),
                ...(outcome.ok ? {} : { error: this.producerError(outcome.errorBody) }),
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- List ----------------------------------------------------------------

    /** GET /v1/template/{ref}/runs */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const template = await this.loadTemplate(req, res);
            if (!template) return;

            const db = await getDB();
            const owner = this.getOwner(req);
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listTemplateRunsByOwner(db, owner, {
                limit,
                cursor,
                templateUuid: template.uuid,
            });

            // Optional client-side status filter (kept simple; DB list is not filtered
            // by status so this narrows the current page only).
            const status = this.strParam(req.query.status);
            const items = status ? page.items.filter((r: any) => r.status === status) : page.items;

            res.json({
                success: true,
                data: {
                    runs: items.map((r: any) => this.formatRun(r, req.params.templateRef!, template.templateId)),
                    next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Get -----------------------------------------------------------------

    /** GET /v1/template/{ref}/runs/{run_id} */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const loaded = await this.loadOwnedRun(req, res);
            if (!loaded) return;
            const { template } = loaded;
            let { run } = loaded;

            // A still-running single crawl derives its live status from the legacy job.
            run = await this.refreshCrawlRun(run);

            res.json({
                success: true,
                data: this.formatRun(run, req.params.templateRef!, template.templateId),
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Cancel --------------------------------------------------------------

    /** POST /v1/template/{ref}/runs/{run_id}/cancel */
    public cancel = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const loaded = await this.loadOwnedRun(req, res);
            if (!loaded) return;
            const { template, run } = loaded;

            // Idempotent: an already-terminal run returns its current state.
            if ((TEMPLATE_RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
                res.json({
                    success: true,
                    data: this.formatRun(run, req.params.templateRef!, template.templateId),
                });
                return;
            }

            const cancelled = await requestTemplateRunCancel(run.uuid);

            // Best-effort: stop the backing crawl job so the worker short-circuits.
            if (run.legacyJobUuid) {
                try {
                    await this.adapter.cancelCrawlJob(run.legacyJobUuid);
                } catch (e) {
                    log.warning(
                        `[TEMPLATE-RUN] cancelCrawlJob failed for ${run.legacyJobUuid}: ${e instanceof Error ? e.message : String(e)}`
                    );
                }
            }

            res.json({
                success: true,
                data: this.formatRun(cancelled ?? run, req.params.templateRef!, template.templateId),
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Events --------------------------------------------------------------

    /** GET /v1/template/{ref}/runs/{run_id}/events */
    public events = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const loaded = await this.loadOwnedRun(req, res);
            if (!loaded) return;
            const { run } = loaded;

            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listTemplateRunEvents(run.uuid, { limit, cursor });
            res.json({
                success: true,
                data: {
                    events: serializeRecords(page.items),
                    next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Warnings ------------------------------------------------------------

    /** GET /v1/template/{ref}/runs/{run_id}/warnings */
    public warnings = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const loaded = await this.loadOwnedRun(req, res);
            if (!loaded) return;
            const { run } = loaded;

            const db = await getDB();
            const limit = this.parseLimit(req.query.limit);
            const cursor = this.parseCursor(req, res);
            if (cursor === false) return;

            const page = await listTemplateRunWarnings(db, run.uuid, {
                limit,
                cursor,
                code: this.strParam(req.query.code),
                scope: this.strParam(req.query.scope),
                itemKey: this.strParam(req.query.item_key),
            });
            res.json({
                success: true,
                data: {
                    warnings: serializeRecords(page.items),
                    next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Dataset -------------------------------------------------------------

    /** GET /v1/template/{ref}/runs/{run_id}/dataset */
    public dataset = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const loaded = await this.loadOwnedRun(req, res);
            if (!loaded) return;
            const { run } = loaded;

            res.json({
                success: true,
                data: {
                    dataset_id: run.datasetId ?? null,
                    dataset_run_id: run.datasetRunUuid ?? null,
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    // --- Helpers -------------------------------------------------------------

    private currentUserId(req: RequestWithAuth): string | undefined {
        return req.auth?.user ? String(req.auth.user) : undefined;
    }

    private getOwner(req: RequestWithAuth): OwnerContext {
        return { apiKeyId: req.auth?.uuid, userId: req.auth?.user };
    }

    private idempotencyKey(req: RequestWithAuth): string | undefined {
        const fromGetter = typeof req.get === "function" ? req.get("Idempotency-Key") : undefined;
        const raw = fromGetter ?? (req.headers as any)?.["idempotency-key"];
        if (raw === undefined || raw === null) return undefined;
        const key = Array.isArray(raw) ? raw[0] : String(raw);
        return key && key.length > 0 ? key : undefined;
    }

    /** Normalized, storable input snapshot (only the fields that affect a run). */
    private buildInputSnapshot(body: z.infer<typeof runCreateSchema>): Record<string, unknown> {
        const snapshot: Record<string, unknown> = {};
        if (body.variables !== undefined) snapshot.variables = body.variables;
        if (body.url !== undefined) snapshot.url = body.url;
        if (body.query !== undefined) snapshot.query = body.query;
        if (body.run_options !== undefined) snapshot.run_options = body.run_options;
        if (body.output !== undefined) snapshot.output = body.output;
        return snapshot;
    }

    /**
     * Resolve the template in the path (404 when missing). Shared by list and the
     * per-run readers so a run is always validated against its parent template.
     */
    private async loadTemplate(req: RequestWithAuth, res: Response): Promise<any | null> {
        const ref = req.params.templateRef ?? "";
        if (!ref) {
            this.notFound(res, "template_not_found", `Template not found: ${ref}`);
            return null;
        }
        const template = await resolveTemplateByRef(ref);
        if (!template) {
            this.notFound(res, "template_not_found", `Template not found: ${ref}`);
            return null;
        }
        return template;
    }

    /**
     * Load an owner-scoped run and assert it belongs to the path template
     * (design §6.2 rule 4: validate template↔run association AND owner). A
     * cross-owner or cross-template run yields 404 without leaking existence.
     */
    private async loadOwnedRun(
        req: RequestWithAuth,
        res: Response
    ): Promise<{ template: any; run: any } | null> {
        const template = await this.loadTemplate(req, res);
        if (!template) return null;

        const runId = req.params.run_id ?? "";
        if (!runId) {
            this.notFound(res, "run_not_found", "Run not found");
            return null;
        }

        const db = await getDB();
        const run = await getOwnedTemplateRun(db, runId, this.getOwner(req));
        if (!run || run.templateUuid !== template.uuid) {
            this.notFound(res, "run_not_found", "Run not found");
            return null;
        }
        return { template, run };
    }

    /**
     * Refresh a single crawl run's status from its backing legacy job. Only acts
     * on a non-terminal run bound to a legacy job; a finished job finalizes the
     * run to the mapped terminal state.
     */
    private async refreshCrawlRun(run: any): Promise<any> {
        const nonTerminal = !(TEMPLATE_RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status);
        if (!nonTerminal || !run.legacyJobUuid) return run;

        const job = await getJob(run.legacyJobUuid);
        if (!job) return run;

        let terminal: "completed" | "failed" | "cancelled" | null = null;
        if (job.status === STATUS.COMPLETED) terminal = "completed";
        else if (job.status === STATUS.FAILED) terminal = "failed";
        else if (job.status === STATUS.CANCELLED) terminal = "cancelled";
        if (!terminal) return run;

        const finalized = await finalizeTemplateRun(run.uuid, terminal, {
            statistics: {
                legacy_job_id: run.legacyJobUuid,
                total: job.total ?? 0,
                completed: job.completed ?? 0,
                failed: job.failed ?? 0,
            },
        });
        return finalized ?? { ...run, status: terminal };
    }

    /** Shape a `template_runs` row into the public run resource + resource links. */
    private formatRun(
        run: any,
        templateRef: string,
        templateId: string,
        extra?: Record<string, unknown>
    ): Record<string, unknown> {
        const base = `/v1/template/${templateRef}/runs/${run.uuid}`;
        return {
            run_id: run.uuid,
            template_id: templateId,
            template_revision_id: run.templateRevisionUuid ?? null,
            mode: run.mode ?? null,
            status: run.status ?? null,
            dataset_id: run.datasetId ?? null,
            dataset_run_id: run.datasetRunUuid ?? null,
            legacy_job_id: run.legacyJobUuid ?? null,
            stop_reason: run.stopReason ?? null,
            error_code: run.errorCode ?? null,
            error_message: run.errorMessage ?? null,
            statistics: run.statistics ?? null,
            created_at: this.iso(run.createdAt),
            started_at: this.iso(run.startedAt),
            finished_at: this.iso(run.finishedAt),
            cancel_requested_at: this.iso(run.cancelRequestedAt),
            ...(extra ?? {}),
            links: {
                self: base,
                events: `${base}/events`,
                warnings: `${base}/warnings`,
                dataset: `${base}/dataset`,
                cancel: `${base}/cancel`,
            },
        };
    }

    private iso(value: unknown): string | null {
        if (value === undefined || value === null) return null;
        const d = value instanceof Date ? value : new Date(value as any);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }

    private producerError(body: any): string {
        if (body && typeof body.error === "string") return body.error;
        return "producer_failed";
    }

    private parseLimit(raw: unknown): number {
        let n = Number.parseInt(String(raw ?? ""), 10);
        if (!Number.isFinite(n) || n <= 0) n = DEFAULT_LIMIT;
        if (n > MAX_LIMIT) n = MAX_LIMIT;
        return n;
    }

    private parseCursor(req: RequestWithAuth, res: Response): Cursor | null | false {
        if (req.query.cursor === undefined) return null;
        try {
            return decodeCursor(String(req.query.cursor));
        } catch (error) {
            if (error instanceof InvalidCursorError) {
                this.badRequest(res, "invalid_cursor", "Malformed pagination cursor");
                return false;
            }
            throw error;
        }
    }

    private strParam(raw: unknown): string | undefined {
        if (raw === undefined || raw === null) return undefined;
        const s = String(raw);
        return s.length > 0 ? s : undefined;
    }

    private mergeValidationError(res: Response, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        const code = /variable/i.test(message)
            ? "invalid_variables"
            : /url|domain|keyword|query/i.test(message)
                ? "invalid_url"
                : "Validation error";
        res.status(400).json({ success: false, error: code, message });
    }

    private notFound(res: Response, code: string, message: string): void {
        res.status(404).json({ success: false, error: code, message });
    }

    private forbidden(res: Response): void {
        res.status(403).json({
            success: false,
            error: "Access denied",
            message: "You don't have permission to use this template",
            data: { type: "ACCESS_DENIED" },
        });
    }

    private badRequest(res: Response, code: string, message: string): void {
        res.status(400).json({ success: false, error: code, message });
    }

    private internalError(res: Response, error: unknown): void {
        log.error(`Template run controller error: ${error}`);
        res.status(500).json({
            success: false,
            error: "Internal server error",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message,
                details: formattedErrors,
            });
            return;
        }
        this.internalError(res, error);
    }
}
