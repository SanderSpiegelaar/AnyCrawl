import { log, normalizeUrl } from "@anycrawl/libs";
import { TemplateClient } from "@anycrawl/template-client";
import {
    getTemplateRevision,
    getTemplateRun,
    updateTemplateRunStatus,
    finalizeTemplateRun,
    appendTemplateRunEvent,
    enqueueTemplateRunRequest,
    claimNextTemplateRunRequest,
    updateTemplateRunRequestStatus,
    countTemplateRunRequestsByStatus,
    writeResultToDataset,
    createJob,
    getJobResults,
    getDB,
    schemas,
} from "@anycrawl/db";
import { QueueManager } from "../managers/Queue.js";
import type { TemplateRunJobPayload } from "../managers/Queue.js";

// ---------------------------------------------------------------------------
// Platform hard caps (design §7). These are ceilings the platform enforces;
// a run's `run_options` (and a template's declared defaults) may only LOWER
// them, never raise them.
// ---------------------------------------------------------------------------
const HARD_CAPS = {
    max_seeds: 100,
    max_items: 10000,
    max_pages_per_seed: 100,
    max_run_time_seconds: 7200,
} as const;

/** A row from the request ledger (loose — the DB layer returns `any`). */
interface RequestRow {
    uuid: string;
    seedKey?: string | null;
    seedIndex?: number | null;
    pageIndex?: number | null;
    normalizedUrl: string;
    status: string;
}

interface FetchedPage {
    url: string;
    rawHtml?: string;
    html?: string;
    markdown?: string;
}

/** Optional overrides for deterministic unit tests. */
export interface OrchestratedRunnerDeps {
    /** Inject a pre-built (or mock) TemplateClient. */
    client?: TemplateClient;
    /** Override the per-page fetch (bypasses the scrape queue in tests). */
    fetchPage?: (engine: string, url: string, payload: TemplateRunJobPayload) => Promise<FetchedPage>;
    /** Injected clock. */
    now?: () => number;
}

/**
 * L3 OrchestratedRunner — the `template-run` worker body (design §9 / Craigslist
 * Phase 1). Expands seeds via the template's seedHandler, then drains the request
 * ledger sequentially: fetch each page (plain scrape job, no template_id), run the
 * page handler, stream items to the Dataset Writer, and paginate via `nextUrl`
 * until a stop condition. Enforces the platform hard caps as ceilings, persists
 * warnings + statistics, and finalizes the run to a terminal state.
 *
 * Idempotent / resumable: the request ledger's unique (run, request_key) index
 * makes re-enqueue a no-op, dataset unique indexes make re-write a no-op, and a
 * BullMQ retry re-enters `run()` to drain whatever requests remain queued — so
 * already-visited nextUrls and already-written items are never double-processed.
 */
export class OrchestratedRunner {
    private client: TemplateClient;
    private fetchPageImpl?: OrchestratedRunnerDeps["fetchPage"];
    private nowFn: () => number;

    constructor(deps?: OrchestratedRunnerDeps) {
        this.client = deps?.client ?? new TemplateClient();
        this.fetchPageImpl = deps?.fetchPage;
        this.nowFn = deps?.now ?? (() => Date.now());
    }

    async run(payload: TemplateRunJobPayload): Promise<void> {
        const runId = payload.runId;
        const engine = payload.engine || "cheerio";
        const runOptions = payload.runOptions ?? {};

        // --- Load the frozen revision + reconstruct the TemplateConfig ---------
        let revision: any;
        try {
            revision = await getTemplateRevision(payload.templateRevisionId);
        } catch (e) {
            revision = null;
        }
        if (!revision) {
            await this.failRun(runId, "template_revision_missing",
                `Template revision ${payload.templateRevisionId} not found`, this.emptyStats(false));
            return;
        }
        const templateConfig = this.reconstructTemplateConfig(revision, payload);

        // Template-declared defaults (may only lower the hard caps).
        const templateDefaults: Record<string, any> =
            (templateConfig as any)?.runtime?.defaultRunOptions ?? {};

        const maxSeeds = this.resolveCap("max_seeds", runOptions, templateDefaults);
        const maxItems = this.resolveCap("max_items", runOptions, templateDefaults);
        const maxPagesPerSeed = this.resolveCap("max_pages_per_seed", runOptions, templateDefaults);
        const maxRunTime = this.resolveCap("max_run_time_seconds", runOptions, templateDefaults);
        const deadline = this.nowFn() + maxRunTime * 1000;

        // Mark the run running (idempotent; terminal runs are guarded by updateStatus).
        await updateTemplateRunStatus(runId, { status: "running", startedAt: new Date() });
        await appendTemplateRunEvent(runId, "run.started", {
            templateRevisionId: payload.templateRevisionId,
            caps: { maxSeeds, maxItems, maxPagesPerSeed, maxRunTime },
        });

        // --- Run-scoped accumulators ------------------------------------------
        let pagesFetched = 0;
        let itemsFound = 0;      // items emitted by page handlers
        let itemsReturned = 0;   // items successfully streamed to the Dataset Writer
        let warningsCount = 0;
        let globalPageCounter = 0;
        const pagesBySeed = new Map<string, number>();

        let anyPageFailed = false;
        let anyWriteFailed = false;
        let cancelled = false;
        let timedOut = false;
        let maxItemsHit = false;
        let maxPagesHit = false;
        let coverageComplete = true;

        const recordWarning = async (w: {
            scope: string;
            code: string;
            message?: string;
            seedKey?: string | null;
            seedIndex?: number | null;
            pageIndex?: number | null;
            url?: string | null;
        }): Promise<void> => {
            warningsCount++;
            try {
                const db = await getDB();
                await db.insert(schemas.runWarnings).values({
                    templateRunUuid: runId,
                    datasetRunId: null,
                    scope: w.scope,
                    code: w.code,
                    message: w.message ?? null,
                    itemKey: null,
                    url: w.url ?? null,
                    seedKey: w.seedKey ?? null,
                    seedIndex: w.seedIndex ?? null,
                    pageIndex: w.pageIndex ?? null,
                    createdAt: new Date(),
                });
            } catch (e) {
                log.warning(`[template-run] [${runId}] failed to persist run_warning ${w.code}: ${e}`);
            }
        };

        // --- Seed expansion (skipped on resume when requests already exist) ----
        const existingCounts = await countTemplateRunRequestsByStatus(runId);
        const existingTotal = Object.values(existingCounts).reduce((a, b) => a + b, 0);

        if (existingTotal === 0) {
            let seeds: Array<{ seedKey: string; url: string; metadata?: any }>;
            try {
                const seedResult = await this.client.runSeedHandler({
                    templateConfig,
                    variables: payload.variables ?? {},
                });
                seeds = Array.isArray(seedResult?.seeds) ? seedResult.seeds : [];
                for (const w of seedResult?.warnings ?? []) {
                    await recordWarning({ scope: "seed", code: w?.code ?? "seed_warning", message: w?.message });
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                await recordWarning({ scope: "run", code: "seed_handler_error", message: msg });
                await this.failRun(runId, "seed_handler_error", msg, {
                    pages_fetched: 0,
                    items_found: 0,
                    items_returned: 0,
                    warnings: warningsCount,
                    coverage_complete: false,
                });
                return;
            }

            // Seed cap is enforced BEFORE dispatch: exceeding it fails the run
            // rather than silently truncating (Craigslist §7 rule 5 / platform §7).
            if (seeds.length > maxSeeds) {
                await recordWarning({
                    scope: "run",
                    code: "seed_limit_exceeded",
                    message: `Seed count ${seeds.length} exceeds max_seeds ${maxSeeds}`,
                });
                await this.failRun(runId, "seed_limit_exceeded",
                    `Seed count ${seeds.length} exceeds max_seeds ${maxSeeds}`, {
                    pages_fetched: 0,
                    items_found: 0,
                    items_returned: 0,
                    warnings: warningsCount,
                    coverage_complete: false,
                });
                return;
            }

            let seedIndex = 0;
            for (const seed of seeds) {
                const check = this.normalizeAndValidate(templateConfig, seed.url);
                if (!check.ok) {
                    coverageComplete = false;
                    await recordWarning({
                        scope: "seed",
                        code: "seed_url_rejected",
                        message: check.reason,
                        seedKey: seed.seedKey,
                        seedIndex,
                        url: seed.url,
                    });
                    seedIndex++;
                    continue;
                }
                await enqueueTemplateRunRequest({
                    templateRunUuid: runId,
                    requestType: "page",
                    seedKey: seed.seedKey,
                    seedIndex,
                    pageIndex: 1,
                    normalizedUrl: check.url,
                    requestKey: `page:${seed.seedKey}:${check.url}`,
                });
                seedIndex++;
            }
            await appendTemplateRunEvent(runId, "run.seeds_enqueued", { seedCount: seeds.length });
        } else {
            log.info(`[template-run] [${runId}] resuming; ${existingTotal} request(s) already in ledger`);
        }

        // --- Drain loop (sequential, concurrency = 1) --------------------------
        let stoppedHard = false;
        for (; ;) {
            // Reload run status for cancellation.
            const runRow = await getTemplateRun(runId);
            if (runRow?.status === "cancelling") {
                cancelled = true;
                coverageComplete = false;
                stoppedHard = true;
                break;
            }
            if (this.nowFn() > deadline) {
                timedOut = true;
                coverageComplete = false;
                stoppedHard = true;
                break;
            }
            if (itemsFound >= maxItems) {
                maxItemsHit = true;
                coverageComplete = false;
                stoppedHard = true;
                break;
            }

            const req: RequestRow | null = await claimNextTemplateRunRequest(runId);
            if (!req) break; // ledger drained

            const seedKey = req.seedKey ?? "";
            const pageIndex = req.pageIndex ?? 1;

            // --- Fetch the page (plain scrape job, no template_id) ---
            let page: FetchedPage;
            try {
                page = await this.fetchPage(engine, req.normalizedUrl, payload, (templateConfig as any)?.reqOptions ?? {});
            } catch (e) {
                anyPageFailed = true;
                coverageComplete = false;
                const msg = e instanceof Error ? e.message : String(e);
                await recordWarning({
                    scope: "page",
                    code: "fetch_failed",
                    message: msg,
                    seedKey,
                    seedIndex: req.seedIndex,
                    pageIndex,
                    url: req.normalizedUrl,
                });
                await updateTemplateRunRequestStatus(req.uuid, {
                    status: "failed",
                    lastError: msg,
                    finishedAt: new Date(),
                });
                continue;
            }

            // --- Run the page handler in the trust-branched sandbox ---
            let handler: any;
            try {
                handler = await this.client.runPageHandler({
                    templateConfig,
                    variables: payload.variables ?? {},
                    requestType: "page",
                    scrapeResult: {
                        url: page.url,
                        rawHtml: page.rawHtml,
                        html: page.html,
                        markdown: page.markdown,
                    },
                    context: {
                        runId,
                        templateRevisionId: payload.templateRevisionId,
                        seedKey,
                        pageIndex,
                        attempt: 1,
                    },
                });
            } catch (e) {
                anyPageFailed = true;
                coverageComplete = false;
                const msg = e instanceof Error ? e.message : String(e);
                await recordWarning({
                    scope: "page",
                    code: "page_handler_error",
                    message: msg,
                    seedKey,
                    seedIndex: req.seedIndex,
                    pageIndex,
                    url: req.normalizedUrl,
                });
                await updateTemplateRunRequestStatus(req.uuid, {
                    status: "failed",
                    lastError: msg,
                    finishedAt: new Date(),
                });
                continue;
            }

            const items: any[] = Array.isArray(handler?.items) ? handler.items : [];
            const nextUrl: string | null = handler?.nextUrl ?? null;
            const detailRequests: any[] = Array.isArray(handler?.detailRequests) ? handler.detailRequests : [];
            if (detailRequests.length > 0) {
                // Phase 1: detail fan-out is intentionally not implemented.
                log.info(`[template-run] [${runId}] ignoring ${detailRequests.length} detailRequest(s) (Phase 1)`);
            }

            pagesFetched++;
            pagesBySeed.set(seedKey, (pagesBySeed.get(seedKey) ?? 0) + 1);

            // --- Stream items to the Dataset Writer (isolated; never aborts) ---
            if (items.length > 0) {
                itemsFound += items.length;
                try {
                    await writeResultToDataset({
                        producerType: "template-run",
                        producerId: runId,
                        jobId: runId,
                        scope: { kind: "job", jobId: runId },
                        scopeType: "orchestrated",
                        result: { items },
                        mapping: payload.dataset.mapping as any,
                        owner: payload.dataset.owner,
                        dataset: this.datasetTarget(payload),
                        pageIndex: globalPageCounter++,
                        finalizeRun: false,
                    });
                    itemsReturned += items.length;
                } catch (e) {
                    // Mirror engines/Base.ts: a dataset write failure only warns and
                    // marks the run partial-at-finalize; it never aborts the page.
                    anyWriteFailed = true;
                    coverageComplete = false;
                    const msg = e instanceof Error ? e.message : String(e);
                    await recordWarning({
                        scope: "page",
                        code: "dataset_write_failed",
                        message: msg,
                        seedKey,
                        seedIndex: req.seedIndex,
                        pageIndex,
                        url: req.normalizedUrl,
                    });
                }
            }

            // Handler-emitted (item + page) warnings.
            for (const w of handler?.warnings ?? []) {
                await recordWarning({
                    scope: w?.scope ?? "item",
                    code: w?.code ?? "handler_warning",
                    message: w?.message,
                    seedKey,
                    seedIndex: req.seedIndex,
                    pageIndex,
                    url: w?.url ?? req.normalizedUrl,
                });
            }

            await updateTemplateRunRequestStatus(req.uuid, { status: "completed", finishedAt: new Date() });

            // --- Pagination decision ------------------------------------------
            // 1) per-seed page cap → warn, stop this seed (no next).
            if ((pagesBySeed.get(seedKey) ?? 0) >= maxPagesPerSeed) {
                maxPagesHit = true;
                coverageComplete = false;
                await recordWarning({
                    scope: "seed",
                    code: "max_pages_reached",
                    message: `Seed ${seedKey} reached max_pages_per_seed ${maxPagesPerSeed}`,
                    seedKey,
                    seedIndex: req.seedIndex,
                    pageIndex,
                });
                continue;
            }
            // 2) global item cap reached → stop dispatch (do not enqueue next).
            if (itemsFound >= maxItems) {
                maxItemsHit = true;
                coverageComplete = false;
                continue;
            }
            // 3) empty page → natural end for this seed (no next).
            if (items.length === 0) {
                continue;
            }
            // 4) follow nextUrl (validated). The uq_template_run_request unique
            //    index makes an already-visited nextUrl a no-op — this IS the
            //    visited-URL / pagination-loop dedup.
            if (nextUrl) {
                const check = this.normalizeAndValidate(templateConfig, nextUrl);
                if (!check.ok) {
                    coverageComplete = false;
                    await recordWarning({
                        scope: "page",
                        code: "next_url_rejected",
                        message: check.reason,
                        seedKey,
                        seedIndex: req.seedIndex,
                        pageIndex,
                        url: nextUrl,
                    });
                    continue;
                }
                await enqueueTemplateRunRequest({
                    templateRunUuid: runId,
                    requestType: "page",
                    seedKey,
                    seedIndex: req.seedIndex,
                    pageIndex: pageIndex + 1,
                    normalizedUrl: check.url,
                    requestKey: `page:${seedKey}:${check.url}`,
                });
            }
            // else: no next → natural end for this seed.
        }

        // --- Finalize ---------------------------------------------------------
        // Natural drain: only finalize once no queued/running requests remain.
        // Hard stops (cancel/timeout/max_items) finalize immediately regardless.
        if (!stoppedHard) {
            const counts = await countTemplateRunRequestsByStatus(runId);
            const pending = (counts["queued"] ?? 0) + (counts["running"] ?? 0);
            if (pending > 0) {
                // Another actor still has work in flight; leave finalization to it.
                log.info(`[template-run] [${runId}] ${pending} request(s) still pending; deferring finalize`);
                return;
            }
        }

        const terminal = this.resolveTerminal({
            cancelled,
            anyPageFailed,
            anyWriteFailed,
            itemsReturned,
        });
        const stopReason = this.resolveStopReason({
            cancelled,
            timedOut,
            maxItemsHit,
            maxPagesHit,
            terminal,
        });
        // coverage_complete only when every seed ended naturally with no
        // cap / cancel / timeout / partial.
        const coverage = coverageComplete && terminal === "completed" && stopReason === "completed";

        const statistics = {
            pages_fetched: pagesFetched,
            items_found: itemsFound,
            items_returned: itemsReturned,
            warnings: warningsCount,
            coverage_complete: coverage,
        };

        await finalizeTemplateRun(runId, terminal, {
            stopReason,
            statistics,
            finishedAt: new Date(),
        });
        await appendTemplateRunEvent(runId, "run.finalized", { terminal, stopReason, statistics });
        log.info(`[template-run] [${runId}] finalized ${terminal} (stop=${stopReason}, items=${itemsReturned})`);
    }

    // ------------------------------------------------------------------------
    // Fetch (Option A, zero engine change): enqueue a plain scrape job with NO
    // template_id, wait for it, and read the persisted result row. A `jobs` row
    // is created for the same jobId so the engine's existing insertJobResult /
    // getJobResults path (which key off the jobs table) works unchanged.
    // ------------------------------------------------------------------------
    private async fetchPage(
        engine: string,
        url: string,
        payload: TemplateRunJobPayload,
        reqOptions: Record<string, any> = {}
    ): Promise<FetchedPage> {
        if (this.fetchPageImpl) return this.fetchPageImpl(engine, url, payload);

        const queueName = `scrape-${engine}`;
        const scrapeTimeout =
            Number((reqOptions as any)?.timeout) ||
            Number((payload.runOptions as any)?.request_timeout_ms) ||
            30000;

        // Honor the template's scrape config (proxy, wait_for, wait_until, etc.) so each
        // template controls how its pages are fetched (e.g. Craigslist needs proxies).
        // engine/type/formats are owned by the orchestrator: rawHtml is required by the
        // page handler, so it's always included regardless of the template's formats.
        const { engine: _e, type: _t, formats: tplFormats, timeout: _to, ...restReqOptions } =
            (reqOptions as any) || {};
        const formats = Array.from(
            new Set(["rawHtml", "markdown", ...(Array.isArray(tplFormats) ? tplFormats : [])])
        );

        const jobId = await QueueManager.getInstance().addJob(queueName, {
            url,
            engine: engine as any,
            type: "scrape",
            options: { ...restReqOptions, formats, timeout: scrapeTimeout },
        });

        // Ensure a jobs row exists so Base.ts's insertJobResult + getJobResults
        // (both keyed by jobId → uuid) resolve. Created right after enqueue: the
        // engine only reaches insertJobResult after a full network fetch, so this
        // single insert always commits first.
        try {
            await createJob({
                job_id: jobId,
                job_type: "scrape",
                job_queue_name: queueName,
                url,
                req: {
                    auth: {
                        uuid: payload.dataset?.owner?.apiKeyId ?? payload.ownerContext?.apiKeyId,
                        user: payload.dataset?.owner?.userId ?? payload.ownerContext?.userId,
                    },
                },
                payload: { url, engine },
            });
        } catch (e) {
            log.warning(`[template-run] failed to create backing job row for ${url}: ${e}`);
        }

        await QueueManager.getInstance().waitJobDone(queueName, jobId, scrapeTimeout + 30000);

        const rows = await getJobResults(jobId);
        const row =
            (rows ?? []).find((r: any) => r?.status === "success") ?? (rows ?? [])[0];
        if (!row || row.status === "failed") {
            throw new Error(`scrape produced no successful result for ${url}`);
        }
        const data = row.data ?? {};
        return {
            url: row.url ?? url,
            rawHtml: data.rawHtml,
            html: data.html,
            markdown: data.markdown,
        };
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private datasetTarget(payload: TemplateRunJobPayload): any {
        if (payload.dataset?.datasetId) return { datasetId: payload.dataset.datasetId };
        return { create: payload.dataset?.create };
    }

    /** Effective cap = min(hard cap, run_option, template default). Never above the hard cap. */
    private resolveCap(
        key: keyof typeof HARD_CAPS,
        runOptions: Record<string, any>,
        templateDefaults: Record<string, any>
    ): number {
        const hard = HARD_CAPS[key];
        const candidates: number[] = [hard];
        const fromRun = Number(runOptions?.[key]);
        if (Number.isFinite(fromRun) && fromRun > 0) candidates.push(fromRun);
        const fromTpl = Number(templateDefaults?.[key]);
        if (Number.isFinite(fromTpl) && fromTpl > 0) candidates.push(fromTpl);
        return Math.min(...candidates);
    }

    /**
     * Rebuild a TemplateConfig from the frozen revision snapshot. Only the fields
     * the handlers + validators read matter (templateId, trusted, customHandlers,
     * metadata.allowedDomains, runtime); required TemplateConfig fields are filled
     * with safe fallbacks.
     */
    private reconstructTemplateConfig(revision: any, payload: TemplateRunJobPayload): any {
        const snap = revision?.configSnapshot ?? {};
        return {
            uuid: payload.templateUuid,
            templateId: (snap as any).templateId ?? payload.templateUuid,
            name: (snap as any).name ?? "",
            tags: (snap as any).tags ?? [],
            version: (snap as any).version ?? revision?.version ?? "0.0.0",
            pricing: (snap as any).pricing ?? { perCall: 0, currency: "credits" },
            templateType: (snap as any).templateType ?? "scrape",
            reqOptions: (snap as any).reqOptions ?? {},
            runtime: (snap as any).runtime,
            outputSchema: (snap as any).outputSchema ?? revision?.schemaSnapshot ?? undefined,
            customHandlers: (snap as any).customHandlers,
            metadata: (snap as any).metadata ?? {},
            variables: (snap as any).variables,
            trusted: (snap as any).trusted ?? false,
            createdAt: revision?.createdAt ? new Date(revision.createdAt) : new Date(),
            updatedAt: revision?.createdAt ? new Date(revision.createdAt) : new Date(),
        };
    }

    /**
     * Protocol + host + domain-restriction gate for EVERY seed / nextUrl before
     * enqueue (design §9 rule 6). Rejected URLs are warned + skipped, never relaxed.
     * Returns the normalized URL on success.
     */
    private normalizeAndValidate(
        templateConfig: any,
        url: string
    ): { ok: true; url: string } | { ok: false; reason: string } {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return { ok: false, reason: `invalid URL: ${url}` };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { ok: false, reason: `unsupported protocol: ${parsed.protocol}` };
        }
        if (!parsed.hostname) {
            return { ok: false, reason: "missing host" };
        }
        const domainCheck = this.client.validateDomainRestrictions(templateConfig, url);
        if (!domainCheck.isValid) {
            return { ok: false, reason: domainCheck.error ?? "domain not allowed" };
        }
        return { ok: true, url: normalizeUrl(url) };
    }

    private resolveTerminal(args: {
        cancelled: boolean;
        anyPageFailed: boolean;
        anyWriteFailed: boolean;
        itemsReturned: number;
    }): "completed" | "partial" | "failed" | "cancelled" {
        if (args.cancelled) return "cancelled";
        // A page fetch/handler failure or a dataset write failure yields partial
        // results (design §5 rule 2). `failed` is reserved for init/template
        // errors with zero deliverables, handled inline via failRun().
        if (args.anyPageFailed || args.anyWriteFailed) return "partial";
        return "completed";
    }

    private resolveStopReason(args: {
        cancelled: boolean;
        timedOut: boolean;
        maxItemsHit: boolean;
        maxPagesHit: boolean;
        terminal: string;
    }): string {
        if (args.cancelled) return "cancelled";
        if (args.timedOut) return "max_runtime_reached";
        if (args.maxItemsHit) return "max_items_reached";
        if (args.maxPagesHit) return "max_pages_reached";
        if (args.terminal === "partial") return "failed";
        return "completed";
    }

    private emptyStats(coverage: boolean) {
        return {
            pages_fetched: 0,
            items_found: 0,
            items_returned: 0,
            warnings: 0,
            coverage_complete: coverage,
        };
    }

    /** Finalize a run as failed with zero deliverables (init / template errors). */
    private async failRun(
        runId: string,
        errorCode: string,
        errorMessage: string,
        statistics: Record<string, unknown>
    ): Promise<void> {
        await finalizeTemplateRun(runId, "failed", {
            stopReason: "failed",
            errorCode,
            errorMessage,
            statistics,
            finishedAt: new Date(),
        });
        await appendTemplateRunEvent(runId, "run.finalized", {
            terminal: "failed",
            stopReason: "failed",
            errorCode,
            errorMessage,
        });
        log.error(`[template-run] [${runId}] failed: ${errorCode} — ${errorMessage}`);
    }
}
