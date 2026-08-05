import { log, appConfig, config, CreditCalculator, WebhookEventType } from "@anycrawl/libs";
import { QueueManager } from "../managers/Queue.js";
import { resolveAutoEngine } from "./autoEngine.js";
import {
    completedJob,
    failedJob,
    getJob,
    updateJobStatus,
    updateJobCounts,
    chargeDeltaByJobId,
    STATUS,
} from "@anycrawl/db";

/**
 * Coordinator for batch scrape jobs.
 *
 * Unlike crawl there is no link discovery: the URL set is fixed and known up front.
 * We fan the URLs out as regular `scrape-${engine}` child jobs (recorded under the
 * batch job via `parentId`, exactly like the auto-crawl coordinator) and aggregate
 * their outcomes here. Billing is charged per successful URL against the parent job,
 * so failed URLs are never charged.
 *
 * Runs fire-and-forget from the controller (same lifecycle as `runAutoCrawl`).
 */
export async function runBatchScrape(jobId: string, payload: any): Promise<void> {
    const urls: string[] = Array.isArray(payload?.urls) ? payload.urls : [];
    const options = payload?.options || {};
    const templateVariables = payload?.templateVariables;
    const requestedEngine: string = payload?.engine || "auto";

    const concurrency = resolvePositiveInt(process.env.ANYCRAWL_BATCH_SCRAPE_CONCURRENCY, 10);
    const perJobTimeout = Number(options.timeout) > 0 ? Number(options.timeout) : 60_000;
    // Allow extra headroom over the per-request timeout to absorb queue wait time.
    const waitMs = perJobTimeout + resolvePositiveInt(process.env.ANYCRAWL_BATCH_SCRAPE_WAIT_BUFFER_MS, 60_000);

    const creditsEnabled = appConfig.authEnabled && appConfig.creditsEnabled;
    const templateCredits = Number(payload?.templateCredits ?? 0);
    const perUrlChargeDetails = CreditCalculator.buildScrapeChargeDetails({
        proxy: options.proxy,
        json_options: options.json_options,
        formats: options.formats,
        extract_source: options.extract_source,
    }, { templateCredits });
    const perUrlCost = perUrlChargeDetails.total;

    let completed = 0;
    let failed = 0;

    try {
        await updateJobStatus(jobId, STATUS.PENDING);

        for (let start = 0; start < urls.length; start += concurrency) {
            // Stop enqueuing further work if the job was cancelled.
            try {
                const current = await getJob(jobId);
                if (current?.status === STATUS.CANCELLED) {
                    log.info(`[BatchScrape] ${jobId} cancelled, stopping after ${completed + failed}/${urls.length}`);
                    return;
                }
            } catch { /* ignore transient read errors */ }

            const chunk = urls.slice(start, start + concurrency);
            await Promise.allSettled(
                chunk.map(async (url, offset) => {
                    const index = start + offset;
                    try {
                        const engine = requestedEngine === "auto"
                            ? await resolveAutoEngine(url, options.proxy)
                            : requestedEngine;
                        const queueName = `scrape-${engine}`;

                        const childId = await QueueManager.getInstance().addJob(queueName, {
                            url,
                            engine,
                            options,
                            templateVariables,
                            parentId: jobId,
                            queueName,
                        } as any);

                        const result = await QueueManager.getInstance().waitJobDone(queueName, childId, waitMs);

                        if (!result || result.status === "failed" || result.error) {
                            failed++;
                            return;
                        }

                        completed++;

                        if (creditsEnabled && perUrlCost > 0) {
                            try {
                                await chargeDeltaByJobId({
                                    jobId,
                                    delta: perUrlCost,
                                    reason: "batch_scrape_page_success",
                                    idempotencyKey: `batch:page-success:${jobId}:${index}`,
                                    chargeDetails: perUrlChargeDetails,
                                });
                            } catch (billingError) {
                                log.warning(`[BatchScrape] ${jobId} failed to charge url #${index}: ${billingError}`);
                            }
                        }
                    } catch (jobError) {
                        // Timeout or unexpected error waiting for the child job.
                        failed++;
                        log.debug(`[BatchScrape] ${jobId} url #${index} failed: ${jobError instanceof Error ? jobError.message : jobError}`);
                    }
                })
            );

            // Update live progress counters after each chunk for the status endpoint.
            try {
                await updateJobCounts(jobId, { total: completed + failed, completed, failed });
            } catch { /* best-effort */ }

            await triggerBatchWebhook(jobId, WebhookEventType.BATCH_SCRAPE_PAGE, {
                status: "processing",
                total: urls.length,
                completed,
                failed,
            });
        }

        // If the job was cancelled while chunks were still in flight, do not override
        // its cancelled status with completed/failed.
        try {
            const finalJob = await getJob(jobId);
            if (finalJob?.status === STATUS.CANCELLED) {
                log.info(`[BatchScrape] ${jobId} was cancelled; skipping final status update (completed=${completed}, failed=${failed})`);
                return;
            }
        } catch { /* ignore read errors and proceed to finalize */ }

        if (completed === 0 && failed > 0) {
            await failedJob(jobId, "No URLs were successfully scraped", false, {
                total: completed + failed,
                completed,
                failed,
            });
            await triggerBatchWebhook(jobId, WebhookEventType.BATCH_SCRAPE_FAILED, {
                status: "failed",
                total: completed + failed,
                completed,
                failed,
            });
            return;
        }

        await completedJob(jobId, true, {
            total: completed + failed,
            completed,
            failed,
        });
        await triggerBatchWebhook(jobId, WebhookEventType.BATCH_SCRAPE_COMPLETED, {
            status: "completed",
            total: completed + failed,
            completed,
            failed,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Batch scrape coordinator failed";
        log.error(`[BatchScrape] ${jobId} failed: ${msg}`);
        await failedJob(jobId, msg, false, {
            total: completed + failed,
            completed,
            failed,
        });
        await triggerBatchWebhook(jobId, WebhookEventType.BATCH_SCRAPE_FAILED, {
            status: "failed",
            error_message: msg,
            total: completed + failed,
            completed,
            failed,
        });
    }
}

function resolvePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function triggerBatchWebhook(
    jobId: string,
    eventType: WebhookEventType,
    payload: Record<string, unknown>
): Promise<void> {
    if (!config.webhooks.enabled) return;
    try {
        const dbJob = await getJob(jobId);
        if (!dbJob) return;
        const { WebhookManager } = await import("../managers/Webhook.js");
        await WebhookManager.getInstance().triggerEvent(
            eventType,
            { job_id: jobId, url: dbJob.url, ...payload },
            "batch_scrape",
            jobId,
            dbJob.userId ?? undefined
        );
    } catch (e) {
        log.warning(`[BatchScrape] ${jobId} failed to trigger webhook ${eventType}: ${e}`);
    }
}
