import { extractUrlsFromCheerio } from "crawlee";
import { log } from "@anycrawl/libs";
import { QueueManager } from "../managers/Queue.js";
import { resolveAutoEngine } from "./autoEngine.js";
import { completedJob, failedJob, finalizeCrawlDatasetRun } from "@anycrawl/db";
import { minimatch } from "minimatch";
import * as cheerio from "cheerio";

interface PendingPage {
    url: string;
    depth: number;
}

export async function runAutoCrawl(
    jobId: string,
    payload: any,
): Promise<void> {
    const seedUrl: string = payload.url;
    const opts = payload.crawl_options || {};
    const limit: number = opts.limit || 10;
    const maxDepth: number = opts.max_depth || 10;
    const strategy: string = opts.strategy || "same-domain";
    const includePaths: string[] = opts.include_paths || [];
    const excludePaths: string[] = opts.exclude_paths || [];

    const visited = new Set<string>();
    const pending: PendingPage[] = [{ url: seedUrl, depth: 0 }];
    let completed = 0;
    let failed = 0;

    try {
        while (pending.length > 0 && completed + failed < limit) {
            const batchSize = Math.min(
                5,
                limit - completed - failed,
                pending.length,
            );
            const batch = pending.splice(0, batchSize);

            const results = await Promise.allSettled(
                batch.map(async (page) => {
                    if (visited.has(page.url)) return null;
                    visited.add(page.url);

                    const engine =
                        payload.engine === "auto"
                            ? await resolveAutoEngine(
                                  page.url,
                                  payload.options?.proxy,
                              )
                            : payload.engine;
                    const queueName = `scrape-${engine}`;

                    const scrapeId =
                        await QueueManager.getInstance().addJob(queueName, {
                            ...payload,
                            url: page.url,
                            engine,
                            options: {
                                ...payload.options,
                                formats: [
                                    ...new Set([
                                        ...(payload.options?.formats || [
                                            "markdown",
                                        ]),
                                        "links",
                                    ]),
                                ],
                            },
                            parentId: jobId,
                            type: "crawl",
                            queueName,
                        });

                    const result =
                        await QueueManager.getInstance().waitJobDone(
                            queueName,
                            scrapeId,
                            payload.options?.timeout || 60000,
                        );
                    if (!result || result.status === "failed") {
                        failed++;
                        return null;
                    }
                    completed++;

                    let links: string[] = result.links || [];
                    if (
                        links.length === 0 &&
                        (result.rawHtml || result.html)
                    ) {
                        const $ = cheerio.load(result.rawHtml || result.html);
                        links = extractUrlsFromCheerio(
                            $ as any,
                            "a[href]",
                            page.url,
                        );
                    }
                    return { links, depth: page.depth };
                }),
            );

            for (const r of results) {
                if (r.status !== "fulfilled" || !r.value) continue;
                const { links, depth } = r.value;
                if (depth >= maxDepth) continue;
                for (const link of links) {
                    if (
                        visited.has(link) ||
                        completed + failed + pending.length >= limit
                    )
                        continue;
                    if (!matchesStrategy(link, seedUrl, strategy)) continue;
                    if (!matchesPaths(link, includePaths, excludePaths))
                        continue;
                    pending.push({ url: link, depth: depth + 1 });
                }
            }
        }

        await completedJob(jobId, true, {
            total: completed + failed,
            completed,
            failed,
        });
        await finalizeCrawlDataset(jobId, payload);
    } catch (err) {
        const msg =
            err instanceof Error ? err.message : "Crawl coordinator failed";
        log.error(`[CrawlCoordinator] ${jobId} failed: ${msg}`);
        await failedJob(jobId, msg, false, {
            total: completed + failed,
            completed,
            failed,
        });
        await finalizeCrawlDataset(jobId, payload);
    }
}

/**
 * Dataset output (additive): finalize the crawl's accumulating dataset run at the
 * auto-crawl coordinator's terminal point (this path finalizes via completedJob/
 * failedJob and never reaches ProgressManager.tryFinalize). Per-page writes used
 * finalizeRun:false, so the run is still `running` with unsequenced members; move
 * it to completed/partial and assign the contiguous sequence. Guarded on the crawl
 * carrying an output.dataset binding — a no-op for non-dataset crawls. Best-effort:
 * a finalize failure never changes the coordinator's own job outcome.
 */
async function finalizeCrawlDataset(jobId: string, payload: any): Promise<void> {
    try {
        const datasetId: string | undefined = payload?.options?.dataset?.datasetId;
        if (datasetId) {
            await finalizeCrawlDatasetRun({
                datasetId,
                producerType: "crawl",
                producerId: jobId,
            });
        }
    } catch (err) {
        log.warning(
            `[CrawlCoordinator] ${jobId} dataset finalize failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

function matchesStrategy(
    url: string,
    seedUrl: string,
    strategy: string,
): boolean {
    try {
        const seedHost = new URL(seedUrl).hostname;
        const urlHost = new URL(url).hostname;
        if (strategy === "same-domain") return urlHost === seedHost;
        if (strategy === "same-origin")
            return new URL(url).origin === new URL(seedUrl).origin;
        return true;
    } catch {
        return false;
    }
}

function matchesPaths(
    url: string,
    include: string[],
    exclude: string[],
): boolean {
    if (
        exclude.length > 0 &&
        exclude.some((p) => minimatch(url, p, { dot: true }))
    )
        return false;
    if (include.length > 0)
        return include.some((p) => minimatch(url, p, { dot: true }));
    return true;
}
