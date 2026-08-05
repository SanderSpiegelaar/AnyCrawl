import { Response } from "express";
import { z } from "zod";
import {
    batchScrapeSchema,
    scrapeSchema,
    BatchScrapeJobInput,
    RequestWithAuth,
    estimateTaskCredits,
    WebhookEventType,
    appConfig,
} from "@anycrawl/libs";
import { CrawlerErrorType, runBatchScrape } from "@anycrawl/scrape";
import {
    createJob,
    failedJob,
    getJob,
    getJobResultsPaginated,
    getJobResultsCount,
    cancelJob,
    STATUS,
} from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { TemplateHandler } from "../../utils/templateHandler.js";
import { validateTemplateOnlyFields } from "../../utils/templateValidator.js";
import { renderUrlTemplate } from "../../utils/urlTemplate.js";
import { triggerWebhookEvent } from "../../utils/webhookHelper.js";
import { randomUUID } from "crypto";

const BATCH_QUEUE_LABEL = "batch-scrape";

const resolveMaxUrls = (): number => {
    const parsed = Number.parseInt(process.env.ANYCRAWL_BATCH_SCRAPE_MAX_URLS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
};

export class BatchScrapeController {
    /**
     * Start a batch scrape job (async). Returns a job id to poll.
     */
    public start = async (req: RequestWithAuth, res: Response): Promise<void> => {
        let jobId: string | null = null;
        try {
            const rawBody: Record<string, any> = req.body || {};
            const isTemplate = typeof rawBody.template_id === "string" && rawBody.template_id.trim().length > 0;

            // When using a template, only template_id/urls/variables/ignore_invalid_urls are allowed.
            if (isTemplate && !validateTemplateOnlyFields(rawBody, res, "batch")) {
                return;
            }

            const jobPayload = batchScrapeSchema.parse(rawBody);

            // De-duplicate (preserve order) and validate URL format.
            const seen = new Set<string>();
            const validUrls: string[] = [];
            const invalidUrls: string[] = [];
            for (const raw of jobPayload.urls) {
                const url = typeof raw === "string" ? raw.trim() : "";
                if (!url || seen.has(url)) continue;
                seen.add(url);
                if (z.string().url().safeParse(url).success) {
                    validUrls.push(url);
                } else {
                    invalidUrls.push(url);
                }
            }

            if (invalidUrls.length > 0 && !jobPayload.ignore_invalid_urls) {
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: `Invalid URLs: ${invalidUrls.slice(0, 5).join(", ")}${invalidUrls.length > 5 ? " ..." : ""}`,
                    data: {
                        type: CrawlerErrorType.VALIDATION_ERROR,
                        invalid_urls: invalidUrls,
                        status: "failed",
                    },
                });
                return;
            }

            if (validUrls.length === 0) {
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: "No valid URLs provided",
                    data: { type: CrawlerErrorType.VALIDATION_ERROR, status: "failed" },
                });
                return;
            }

            const maxUrls = resolveMaxUrls();
            if (validUrls.length > maxUrls) {
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: `Too many URLs: ${validUrls.length} exceeds the limit of ${maxUrls}`,
                    data: { type: CrawlerErrorType.VALIDATION_ERROR, status: "failed" },
                });
                return;
            }

            // Resolve the batch payload. Templates are applied per URL (reusing scrape
            // template semantics: option merge, variable defaults/mapping, URL transform,
            // domain validation) so every child scrape runs the template's handlers.
            let templateCredits = 0;
            let coordinatorPayload: {
                urls: string[];
                engine: string;
                templateVariables: any;
                options: any;
                templateCredits?: number;
            };

            if (isTemplate) {
                const currentUserId = req.auth?.user ? String(req.auth.user) : undefined;
                const resolvedUrls: string[] = [];
                let mergedOptions: any = jobPayload.options;
                let mergedEngine: string = jobPayload.engine;
                let mergedTemplateVariables: any = jobPayload.templateVariables;
                let first = true;
                for (const u of validUrls) {
                    let renderedUrl = u;
                    try { renderedUrl = renderUrlTemplate(u, rawBody.variables); } catch { /* ignore render errors */ }

                    let merged: any;
                    try {
                        merged = await TemplateHandler.mergeRequestWithTemplate(
                            { template_id: rawBody.template_id, url: renderedUrl, variables: rawBody.variables },
                            "scrape",
                            currentUserId
                        );
                    } catch (templateError) {
                        const message = templateError instanceof Error ? templateError.message : "Template processing failed";
                        req.creditsUsed = 0;
                        req.billingChargeDetails = undefined;
                        res.status(400).json({
                            success: false,
                            error: "Template error",
                            message: `${message} (url: ${u})`,
                            data: { type: CrawlerErrorType.VALIDATION_ERROR, message, status: "failed" },
                        });
                        return;
                    }

                    templateCredits = TemplateHandler.reslovePrice(merged.template, "credits", "perCall");
                    delete merged.template;
                    const parsed = scrapeSchema.parse(merged);
                    resolvedUrls.push(parsed.url);
                    if (first) {
                        mergedOptions = parsed.options;
                        mergedEngine = parsed.engine;
                        mergedTemplateVariables = parsed.templateVariables;
                        first = false;
                    }
                }

                coordinatorPayload = {
                    urls: resolvedUrls,
                    engine: mergedEngine,
                    templateVariables: mergedTemplateVariables,
                    options: mergedOptions,
                    templateCredits,
                };
            } else {
                coordinatorPayload = {
                    urls: validUrls,
                    engine: jobPayload.engine,
                    templateVariables: jobPayload.templateVariables,
                    options: jobPayload.options,
                };
            }

            const primaryUrl = coordinatorPayload.urls[0]!;

            // Pre-flight credit estimate (charging happens per successful URL in the coordinator).
            if (req.auth && appConfig.authEnabled && appConfig.creditsEnabled) {
                const userCredits = req.auth.credits;
                const estimatedCredits =
                    estimateTaskCredits("batch_scrape", coordinatorPayload) +
                    templateCredits * coordinatorPayload.urls.length;
                if (estimatedCredits > userCredits) {
                    res.status(402).json({
                        success: false,
                        error: "Insufficient credits",
                        message: `Estimated credits required (${estimatedCredits}) exceeds available credits (${userCredits}).`,
                        details: {
                            total_urls: validUrls.length,
                            estimated_total: estimatedCredits,
                            available_credits: userCredits,
                        },
                    });
                    return;
                }
            }

            jobId = randomUUID();
            req.jobId = jobId;
            // Billing is charged per successful URL by the coordinator; nothing to deduct upfront.
            req.creditsUsed = 0;
            req.billingChargeDetails = undefined;

            await createJob({
                job_id: jobId,
                job_type: "batch_scrape",
                job_queue_name: BATCH_QUEUE_LABEL,
                url: primaryUrl,
                req,
                status: STATUS.PENDING,
                payload: {
                    engine: coordinatorPayload.engine,
                    options: coordinatorPayload.options,
                    total: coordinatorPayload.urls.length,
                    limit: coordinatorPayload.urls.length,
                    ...(isTemplate ? { template_id: rawBody.template_id, template_credits: templateCredits } : {}),
                },
            });

            await triggerWebhookEvent(
                WebhookEventType.BATCH_SCRAPE_CREATED,
                jobId,
                { url: primaryUrl, status: "created", engine: coordinatorPayload.engine, total: coordinatorPayload.urls.length },
                "batch_scrape"
            );
            await triggerWebhookEvent(
                WebhookEventType.BATCH_SCRAPE_STARTED,
                jobId,
                { url: primaryUrl, status: "started", total: validUrls.length },
                "batch_scrape"
            );

            // Fire-and-forget coordinator (same lifecycle as auto-crawl).
            runBatchScrape(jobId, coordinatorPayload).catch((err) => {
                const msg = err instanceof Error ? err.message : "Batch scrape coordinator failed";
                failedJob(jobId!, msg, false, { total: 0, completed: 0, failed: 0 }).catch(() => { });
            });

            res.json({
                success: true,
                data: {
                    job_id: jobId,
                    status: "created",
                    total: validUrls.length,
                    ...(invalidUrls.length > 0 ? { invalid_urls: invalidUrls } : {}),
                    message: "Batch scrape job has been queued for processing",
                },
            });
        } catch (error) {
            if (error instanceof z.ZodError) {
                const formattedErrors = error.errors.map((err) => ({
                    field: err.path.join("."),
                    message: err.message,
                    code: err.code,
                }));
                const message = error.errors.map((err) => err.message).join(", ");
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message,
                    data: {
                        type: CrawlerErrorType.VALIDATION_ERROR,
                        issues: formattedErrors,
                        message,
                        status: "failed",
                    },
                });
            } else {
                const message = error instanceof Error ? error.message : "Unknown error occurred";
                if (jobId) {
                    await failedJob(jobId, message).catch(() => { });
                }
                req.creditsUsed = 0;
                req.billingChargeDetails = undefined;
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    message,
                    data: { type: CrawlerErrorType.INTERNAL_ERROR, message, status: "failed" },
                });
            }
        }
    };

    /**
     * Get batch scrape job status
     */
    public status = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { jobId } = req.params;
            if (!BatchScrapeJobInput.safeParse({ uuid: jobId }).success) {
                res.status(400).json({ success: false, error: "Invalid job ID", message: "Job ID must be a valid UUID" });
                return;
            }

            const job = await getJob(jobId!);
            if (!job || job.jobType !== "batch_scrape") {
                res.status(400).json({ success: false, error: "Not found", message: "Job not found" });
                return;
            }

            res.json({
                success: true,
                message: "Job status retrieved successfully",
                data: {
                    job_id: jobId,
                    status: job.status,
                    total: job.total ?? 0,
                    completed: job.completed ?? 0,
                    failed: job.failed ?? 0,
                    credits_used: job.creditsUsed ?? 0,
                    expires_at: job.jobExpireAt ? new Date(job.jobExpireAt).toISOString() : undefined,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error occurred";
            res.status(500).json({ success: false, error: "Internal server error", message });
        }
    };

    /**
     * Get batch scrape job results (paginated; supports `skip`)
     */
    public results = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { jobId } = req.params;
            if (!BatchScrapeJobInput.safeParse({ uuid: jobId }).success) {
                res.status(400).json({ success: false, error: "Invalid job ID", message: "Job ID must be a valid UUID" });
                return;
            }

            const job = await getJob(jobId!);
            if (!job || job.jobType !== "batch_scrape") {
                res.status(400).json({ success: false, error: "Not found", message: "Job not found" });
                return;
            }

            const rawSkip = Array.isArray(req.query.skip) ? req.query.skip[0] : req.query.skip;
            const skip = Math.max(0, Number(rawSkip ?? 0) || 0);
            const MAX_PER_PAGE = 100;
            const [total, results] = await Promise.all([
                getJobResultsCount(jobId!),
                getJobResultsPaginated(jobId!, skip, MAX_PER_PAGE),
            ]);

            const hasMore = skip + results.length < total;
            const nextSkip = hasMore ? skip + results.length : undefined;
            const base = process.env.ANYCRAWL_DOMAIN || `${req.protocol}://${req.get("host")}`;
            const nextUrl = hasMore ? `${base}/v1/batch/scrape/${jobId}?skip=${nextSkip}` : undefined;

            const data = results.map((r: any) => {
                const d: any = { ...(r.data ?? {}) };
                if (d && typeof d === "object") {
                    if (d.screenshot) d.screenshot = `${base}/v1/public/storage/file/${d.screenshot}`;
                    if (d["screenshot@fullPage"]) d["screenshot@fullPage"] = `${base}/v1/public/storage/file/${d["screenshot@fullPage"]}`;
                }
                return { ...d, url: r.url };
            });

            res.json({
                success: true,
                status: job.status,
                total: job.total ?? total,
                completed: job.completed ?? 0,
                failed: job.failed ?? 0,
                credits_used: job.creditsUsed ?? 0,
                next: nextUrl,
                data,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error occurred";
            res.status(500).json({ success: false, error: "Internal server error", message });
        }
    };

    /**
     * Cancel a batch scrape job
     */
    public cancel = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { jobId } = req.params;
            if (!BatchScrapeJobInput.safeParse({ uuid: jobId }).success) {
                res.status(400).json({ success: false, error: "Invalid job ID", message: "Job ID must be a valid UUID" });
                return;
            }

            const job = await getJob(jobId!);
            if (!job || job.jobType !== "batch_scrape") {
                res.status(404).json({ success: false, error: "Not found", message: "Job not found" });
                return;
            }
            if ([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(job.status as any)) {
                res.status(409).json({ success: false, error: "Job already finished", message: "Finished jobs cannot be cancelled" });
                return;
            }

            await cancelJob(jobId!);

            await triggerWebhookEvent(
                WebhookEventType.BATCH_SCRAPE_CANCELLED,
                jobId!,
                { url: job.url, status: "cancelled" },
                "batch_scrape"
            );

            res.status(200).json({
                success: true,
                message: "Job cancelled successfully",
                data: { job_id: job.jobId, status: "cancelled" },
            });
        } catch (error) {
            log.error(JSON.stringify(error));
            const message = error instanceof Error ? error.message : "Unknown error occurred";
            res.status(500).json({ success: false, error: "Internal server error", message });
        }
    };
}
