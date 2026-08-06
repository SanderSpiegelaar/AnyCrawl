/**
 * MonitorPostProcessor — runs after a scheduled scrape execution completes
 * successfully. It snapshots content, diffs against the previous run, and fires
 * notifications for meaningful changes.
 *
 * Called from ExecutionLifecycle.finalizeExecution() on the completed branch.
 * Must NEVER throw: wrap all errors and log warnings so the execution lifecycle
 * is never disrupted.
 */

import { randomUUID } from "crypto";
import {
    getDB,
    schemas,
    eq,
    sql,
    getMonitorByScheduledTask,
    getLatestSnapshot,
} from "@anycrawl/db";
import { getJobResults } from "@anycrawl/db";
import { log, config } from "@anycrawl/libs";
import {
    WebhookEventType,
    type MonitorEventPayload,
} from "@anycrawl/libs";
import { LLMExtract, getExtractModelId } from "@anycrawl/ai";
import { normalizeContent, hashContent, truncateForStorage } from "./normalize.js";
import { textDiff, priceDiff, classifyPriceChange } from "./diff.js";
import { judgeChange } from "./judge.js";
import { WebhookManager } from "../managers/Webhook.js";
import { EmailNotifier } from "./EmailNotifier.js";

interface PostProcessInput {
    db?: any;
    scheduledTaskUuid: string;
    executionUuid: string;
    jobUuid?: string;
}

interface UrlChange {
    url: string;
    changeType: string;
    diffText?: string;
    diffJson?: any;
    judgment?: any;
    snapshotUuid: string;
    prevSnapshotUuid?: string;
}

export class MonitorPostProcessor {
    /**
     * Entry point called by finalizeExecution() on the success branch.
     * Safe to call for non-monitor tasks — returns immediately when no monitor
     * config is found for the scheduled task.
     */
    public static async process(input: PostProcessInput): Promise<void> {
        try {
            await MonitorPostProcessor._process(input);
        } catch (err) {
            log.warning(`[MONITOR] post-process uncaught error for execution ${input.executionUuid}: ${err}`);
        }
    }

    /**
     * Called by finalizeExecution() on the failed branch. Records an 'error'
     * snapshot so failed checks are visible in the monitor detail, and emits a
     * monitor.error webhook event. Never throws.
     */
    public static async processFailure(input: PostProcessInput & {
        errorMessage?: string;
        errorCode?: string;
    }): Promise<void> {
        try {
            const db = input.db || await getDB();
            const monitor = await getMonitorByScheduledTask(db, input.scheduledTaskUuid);
            if (!monitor) return;

            const url: string = (monitor.targets as any)?.[0]?.url ?? "";
            await db.insert(schemas.monitorSnapshots).values({
                uuid: randomUUID(),
                monitorUuid: monitor.uuid,
                taskExecutionUuid: input.executionUuid,
                url,
                contentHash: "",
                content: input.errorMessage ?? null,
                extracted: null,
                status: "error",
                capturedAt: new Date(),
            });

            if (config.webhooks.enabled) {
                const payload: MonitorEventPayload = {
                    monitor_id: monitor.uuid,
                    monitor_name: monitor.name,
                    monitor_type: monitor.monitorType,
                    url,
                    error: {
                        message: input.errorMessage ?? "Check failed",
                        code: input.errorCode,
                    },
                    captured_at: new Date().toISOString(),
                };
                try {
                    await WebhookManager.getInstance().triggerEvent(
                        WebhookEventType.MONITOR_ERROR,
                        payload,
                        "monitor",
                        monitor.uuid,
                        monitor.userId ?? undefined
                    );
                } catch (err) {
                    log.warning(`[MONITOR] monitor.error webhook failed: ${err}`);
                }
            }
        } catch (err) {
            log.warning(`[MONITOR] processFailure uncaught error for execution ${input.executionUuid}: ${err}`);
        }
    }

    private static async _process(input: PostProcessInput): Promise<void> {
        const db = input.db || await getDB();

        // 1. Look up the monitor config keyed by the scheduled task. Exit fast
        //    for the common case (non-monitor scheduled tasks).
        const monitor = await getMonitorByScheduledTask(db, input.scheduledTaskUuid);
        if (!monitor) return;

        // 2. Resolve jobUuid → the string jobId used by job_results.
        //    finalizeExecution may not pass jobUuid on the worker success path.
        let jobUuid = input.jobUuid;
        if (!jobUuid) {
            const execRows = await db
                .select({ jobUuid: schemas.taskExecutions.jobUuid })
                .from(schemas.taskExecutions)
                .where(eq(schemas.taskExecutions.uuid, input.executionUuid))
                .limit(1);
            jobUuid = execRows[0]?.jobUuid ?? undefined;
        }
        if (!jobUuid) {
            log.warning(`[MONITOR] No jobUuid for execution ${input.executionUuid} — skipping diff`);
            return;
        }

        // 3. jobs.uuid (PK, uuid) → jobs.jobId (string, used by job_results API)
        const jobRows = await db
            .select({ jobId: schemas.jobs.jobId })
            .from(schemas.jobs)
            .where(eq(schemas.jobs.uuid, jobUuid))
            .limit(1);
        const jobId = jobRows[0]?.jobId;
        if (!jobId) {
            log.warning(`[MONITOR] No jobs row for uuid=${jobUuid} — skipping diff`);
            return;
        }

        // 4. Fetch all result rows for this job (one per URL).
        let results: any[];
        try {
            results = await getJobResults(jobId);
        } catch (err) {
            log.warning(`[MONITOR] getJobResults failed for jobId=${jobId}: ${err}`);
            return;
        }
        if (!results || results.length === 0) {
            log.debug(`[MONITOR] No results for jobId=${jobId}`);
            return;
        }

        const diffOptions = (monitor.diffOptions as any) ?? {};
        const notifyOptions = (monitor.notifyOptions as any) ?? {};
        const onlyMeaningful: boolean = notifyOptions.only_meaningful !== false;
        const trackMode: string = monitor.trackMode ?? "text";

        const changes: UrlChange[] = [];
        // Snapshot-status tally for the check-completed summary (per URL).
        const counters = { new: 0, same: 0, changed: 0, error: 0 };

        // 5. Process each URL result.
        for (const result of results) {
            try {
                await MonitorPostProcessor._processResult({
                    db,
                    monitor,
                    executionUuid: input.executionUuid,
                    result,
                    diffOptions,
                    trackMode,
                    onlyMeaningful,
                    changes,
                    counters,
                });
            } catch (err) {
                log.warning(`[MONITOR] Error processing result url=${result.url}: ${err}`);
            }
        }

        // 6. Notify.
        if (changes.length > 0) {
            await MonitorPostProcessor._notify(monitor, changes, results.length, notifyOptions, counters);
        } else {
            // Fire a "check completed, no changes" summary when webhooks are enabled.
            await MonitorPostProcessor._notifyCheckCompleted(monitor, results.length, 0, counters);
        }
    }

    private static async _processResult(params: {
        db: any;
        monitor: any;
        executionUuid: string;
        result: any;
        diffOptions: any;
        trackMode: string;
        onlyMeaningful: boolean;
        changes: UrlChange[];
        counters: { new: number; same: number; changed: number; error: number };
    }): Promise<void> {
        const { db, monitor, executionUuid, result, diffOptions, trackMode, onlyMeaningful, changes, counters } = params;

        const url: string = result.url;
        const data: Record<string, any> = result.data ?? {};

        // Failed page results (HTTP error / bot-block interstitials) must not be
        // diffed as content — that would raise a false "changed" alert now and a
        // second false alert when the page recovers. Record an error snapshot so
        // the failed check stays visible, then stop.
        if (result.status === "failed") {
            await db.insert(schemas.monitorSnapshots).values({
                uuid: randomUUID(),
                monitorUuid: monitor.uuid,
                taskExecutionUuid: executionUuid,
                url,
                contentHash: "",
                content: null,
                extracted: null,
                status: "error",
                capturedAt: new Date(),
            });
            counters.error++;
            return;
        }

        // 5a. Normalize + hash current content.
        const normalizeOpts = {
            ignoreSelectors: diffOptions.ignore_selectors,
            onlyMainContent: diffOptions.only_main_content,
        };
        const normalized = normalizeContent(data, normalizeOpts);
        // Hash the FULL normalized content (so any change is detected), but store and
        // diff the truncated form. Both current and previous snapshots hold the truncated
        // text, so textDiff compares like-for-like and never reports the truncation
        // boundary as a spurious change.
        const contentHash = hashContent(normalized);
        const storedContent = truncateForStorage(normalized);

        // 5b. Structured extraction for price/json modes.
        //     The scrape job already runs LLM extraction when json_options + the json
        //     format are set, storing it in data.json — reuse that to avoid a second
        //     (billable, possibly inconsistent) extraction. Fall back to extracting here
        //     only when the scrape result lacks a json payload.
        let extracted: any = undefined;
        if (trackMode === "json" || trackMode === "mixed") {
            if (data.json !== undefined && data.json !== null) {
                extracted = data.json;
            } else if (monitor.extractSchema) {
                try {
                    const modelId = getExtractModelId();
                    const extractor = new LLMExtract(modelId);
                    const extractResult = await extractor.perform(normalized, monitor.extractSchema as any, {
                        prompt: monitor.goal ?? undefined,
                    });
                    extracted = extractResult.data;
                } catch (err) {
                    log.warning(`[MONITOR] Extraction failed for url=${url}: ${err}`);
                }
            }
        }

        // 5c. Get the previous snapshot for this (monitor, url) before writing the new one.
        const prevSnapshot = await getLatestSnapshot(db, monitor.uuid, url);

        // 5d. Determine status.
        let snapshotStatus: string;
        if (!prevSnapshot) {
            snapshotStatus = "new";
        } else if (prevSnapshot.contentHash === contentHash) {
            snapshotStatus = "same";
        } else {
            snapshotStatus = "changed";
        }

        // 5d'. Extraction-failure guard (json/mixed): when the previous snapshot
        // holds extracted data but this run produced none — the fallback LLM
        // extraction threw, OR extraction "succeeded" with an empty/all-null
        // payload ({}, null, or the schema skeleton with every field null),
        // which the extractor returns without throwing — diffing prev vs that
        // would read as "every field removed": a false alert now and a false
        // "re-added" alert when extraction recovers. Write the snapshot as
        // 'error' directly (getLatestSnapshot skips error rows, preserving the
        // healthy baseline) and skip diffing entirely. Applies regardless of
        // whether extraction came from data.json or the extractSchema fallback.
        const extractionFailed =
            (trackMode === "json" || trackMode === "mixed") &&
            !hasExtractedData(extracted) &&
            hasExtractedData(prevSnapshot?.extracted);

        if (extractionFailed) {
            snapshotStatus = "error";
            log.warning(
                `[MONITOR] Extraction produced no data for url=${url} but the previous snapshot has extracted fields — recording an error snapshot and skipping the diff to avoid a false "removed" alert`
            );
        }

        // 5e. Write the snapshot.
        const snapshotUuid = randomUUID();
        await db.insert(schemas.monitorSnapshots).values({
            uuid: snapshotUuid,
            monitorUuid: monitor.uuid,
            taskExecutionUuid: executionUuid,
            url,
            contentHash,
            content: storedContent,
            extracted: extracted ?? null,
            status: snapshotStatus,
            capturedAt: new Date(),
        });

        if (snapshotStatus === "new") counters.new++;
        else if (snapshotStatus === "same") counters.same++;
        else if (snapshotStatus === "error") counters.error++;
        else counters.changed++;

        if (extractionFailed) return;

        // 5f. Skip diff for new/same — baseline is established on first run.
        if (snapshotStatus !== "changed") return;

        // 5g. Compute diff.
        let diffText: string | undefined;
        let diffJson: any[] | undefined;
        let changeType = "content";
        // Whether the truncated-text comparison found a diff (text/mixed modes).
        let textChanged = false;

        if (trackMode === "text" || trackMode === "mixed") {
            const prevNormalized = prevSnapshot.content ?? "";
            // Diff truncated-vs-truncated: prevSnapshot.content was stored truncated, so
            // compare against the truncated current content for a like-for-like diff.
            const tdResult = textDiff(prevNormalized, storedContent);
            // diff_options.min_change_ratio: ignore edits below this fraction of
            // changed lines (0–1). A sub-ratio change is treated exactly like an
            // unchanged text comparison.
            const minRatio =
                typeof diffOptions.min_change_ratio === "number" ? diffOptions.min_change_ratio : 0;
            textChanged = tdResult.changed && (minRatio === 0 || tdResult.ratio >= minRatio);
            if (textChanged) {
                diffText = tdResult.diffText;
            } else if (trackMode === "text") {
                // Content normalized to same string after re-computation: no meaningful diff
                await db.update(schemas.monitorSnapshots)
                    .set({ status: "same" })
                    .where(eq(schemas.monitorSnapshots.uuid, snapshotUuid));
                counters.changed--;
                counters.same++;
                return;
            }
            // Mixed mode: an identical truncated text does NOT mean nothing
            // changed — the hash covers the full content (beyond the 256KB
            // truncation boundary) and the json payload may differ. Leave
            // diffText unset and fall through to the json diff; we only
            // downgrade to "same" when that also finds nothing (below).
        }

        if (trackMode === "json" || trackMode === "mixed") {
            const prevExtracted = prevSnapshot.extracted ?? {};
            const currExtracted = extracted ?? {};
            // Shape drift (e.g. the extractor returned an array where the
            // previous run returned an object): warn but still diff — priceDiff
            // compares by key in that case (array indices become keys), which
            // is noisy but safe and never throws.
            if (
                hasExtractedData(prevExtracted) &&
                hasExtractedData(currExtracted) &&
                (Array.isArray(prevExtracted) !== Array.isArray(currExtracted) ||
                    typeof prevExtracted !== typeof currExtracted)
            ) {
                log.warning(
                    `[MONITOR] Extracted shape drift for url=${url} (prev=${describeShape(prevExtracted)}, current=${describeShape(currExtracted)}) — diffing by keys`
                );
            }
            let fieldDiffs: ReturnType<typeof priceDiff> = [];
            try {
                fieldDiffs = priceDiff(prevExtracted, currExtracted);
            } catch (err) {
                // Defensive: priceDiff handles mismatched shapes, but a diff
                // failure must never take down the whole check.
                log.warning(`[MONITOR] priceDiff failed for url=${url}: ${err} — treating as no field-level diff`);
            }
            if (fieldDiffs.length > 0) {
                const classified = classifyPriceChange(
                    fieldDiffs,
                    (monitor.notifyOptions as any)?.thresholds
                );
                if (classified === null) {
                    // Every field diff is a sub-threshold price move — suppressed per
                    // thresholds.price_change_pct. Leave diffJson unset so json mode
                    // downgrades to "same" below instead of raising a content alert.
                    // Known limit: in mixed mode the same price string may still alert
                    // through the TEXT channel — accepted, since text alerts are a
                    // legitimate signal for mixed monitors.
                } else {
                    diffJson = fieldDiffs;
                    changeType = classified;
                }
            }
        }

        // In pure json (price) mode, a content-hash change with no field-level diff is
        // noise (e.g. a footer date moved). The same holds in mixed mode when BOTH the
        // text diff and the field diff came back empty. Downgrade to "same" and skip
        // the alert.
        const jsonDiffEmpty = !diffJson || diffJson.length === 0;
        if (
            (trackMode === "json" && jsonDiffEmpty) ||
            (trackMode === "mixed" && !textChanged && jsonDiffEmpty)
        ) {
            await db.update(schemas.monitorSnapshots)
                .set({ status: "same" })
                .where(eq(schemas.monitorSnapshots.uuid, snapshotUuid));
            counters.changed--;
            counters.same++;
            return;
        }

        // 5h. AI judgment when a goal is configured.
        let judgment: any = undefined;
        if (monitor.goal && (diffText || diffJson)) {
            const diffForJudge = diffText ?? JSON.stringify(diffJson, null, 2);
            judgment = await judgeChange(monitor.goal, diffForJudge, url);
            if (onlyMeaningful && !judgment.meaningful) {
                log.debug(`[MONITOR] AI judge: not meaningful for url=${url} reason="${judgment.reason}"`);
                return;
            }
        }

        // 5i. Write change record.
        const changeUuid = randomUUID();
        await db.insert(schemas.monitorChanges).values({
            uuid: changeUuid,
            monitorUuid: monitor.uuid,
            url,
            fromSnapshotUuid: prevSnapshot.uuid,
            toSnapshotUuid: snapshotUuid,
            changeType,
            diffText: diffText ?? null,
            diffJson: diffJson ?? null,
            judgment: judgment ?? null,
            notified: false,
            createdAt: new Date(),
        });

        changes.push({
            url,
            changeType,
            diffText,
            diffJson,
            judgment,
            snapshotUuid,
            prevSnapshotUuid: prevSnapshot.uuid,
        });
    }

    private static async _notify(
        monitor: any,
        changes: UrlChange[],
        totalUrls: number,
        notifyOptions: any,
        counters?: { new: number; same: number; changed: number; error: number }
    ): Promise<void> {
        const channels: string[] = notifyOptions.channels ?? ["webhook"];
        const userId: string | undefined = monitor.userId ?? undefined;

        const changedCount = changes.length;

        // Track delivery per change — a change is only marked notified when its
        // own webhook event was enqueued to ≥1 subscription, or the email digest
        // (which contains all changes) was accepted. Silently-undelivered alerts
        // stay visible (notified: false) instead of being falsely marked sent.
        const deliveredUuids = new Set<string>();

        // Fire per-change webhook events
        if (channels.includes("webhook") && config.webhooks.enabled) {
            for (const change of changes) {
                const eventType =
                    change.changeType === "price_up" || change.changeType === "price_down"
                        ? WebhookEventType.MONITOR_PRICE_CHANGED
                        : WebhookEventType.MONITOR_CHANGED;

                const payload: MonitorEventPayload = {
                    monitor_id: monitor.uuid,
                    monitor_name: monitor.name,
                    monitor_type: monitor.monitorType,
                    url: change.url,
                    change_type: change.changeType,
                    diff_text: change.diffText,
                    diff_json: change.diffJson,
                    judgment: change.judgment,
                    captured_at: new Date().toISOString(),
                };

                try {
                    // triggerEvent never rejects — it returns the number of
                    // deliveries enqueued. 0 (no matching subscription or a
                    // lookup failure) must NOT count as delivered.
                    const enqueued = await WebhookManager.getInstance().triggerEvent(
                        eventType,
                        payload,
                        "monitor",
                        monitor.uuid,
                        userId
                    );
                    if (enqueued > 0) deliveredUuids.add(change.snapshotUuid);
                } catch (err) {
                    log.warning(`[MONITOR] Webhook triggerEvent failed: ${err}`);
                }
            }
        }

        // Fire check-completed summary event
        await MonitorPostProcessor._notifyCheckCompleted(monitor, totalUrls, changedCount, counters);

        // Email notification
        if (channels.includes("email") && config.email.enabled) {
            const recipients: string[] = notifyOptions.email_recipients ?? [];
            if (recipients.length > 0) {
                try {
                    // Contract: sendChangeEmail THROWS when nothing was
                    // delivered and resolves otherwise. The digest carries all
                    // changes, so success covers every change in this batch.
                    await EmailNotifier.sendChangeEmail(recipients, monitor, changes);
                    for (const change of changes) deliveredUuids.add(change.snapshotUuid);
                } catch (err) {
                    log.warning(`[MONITOR] Email notification failed: ${err}`);
                }
            }
        }

        // Mark only the changes that actually went out on some channel.
        if (deliveredUuids.size === 0) {
            log.warning(
                `[MONITOR] No notification channel delivered for monitor ${monitor.uuid} — leaving ${changes.length} change(s) unnotified`
            );
            return;
        }
        try {
            const db = await getDB();
            for (const change of changes) {
                if (!deliveredUuids.has(change.snapshotUuid)) continue;
                await db.update(schemas.monitorChanges)
                    .set({ notified: true })
                    .where(
                        sql`${schemas.monitorChanges.monitorUuid} = ${monitor.uuid}
                            AND ${schemas.monitorChanges.toSnapshotUuid} = ${change.snapshotUuid}`
                    );
            }
        } catch (err) {
            log.warning(`[MONITOR] Failed to mark changes as notified: ${err}`);
        }
    }

    private static async _notifyCheckCompleted(
        monitor: any,
        totalUrls: number,
        changedCount: number,
        counters?: { new: number; same: number; changed: number; error: number }
    ): Promise<void> {
        if (!config.webhooks.enabled) return;
        const payload: MonitorEventPayload = {
            monitor_id: monitor.uuid,
            monitor_name: monitor.name,
            monitor_type: monitor.monitorType,
            summary: {
                total: totalUrls,
                // Real per-URL snapshot tallies; the arithmetic fallback covers
                // callers that predate the counters param.
                same: counters?.same ?? totalUrls - changedCount,
                changed: counters?.changed ?? changedCount,
                new: counters?.new ?? 0,
                removed: 0,
                error: counters?.error ?? 0,
            },
            captured_at: new Date().toISOString(),
        };
        try {
            await WebhookManager.getInstance().triggerEvent(
                WebhookEventType.MONITOR_CHECK_COMPLETED,
                payload,
                "monitor",
                monitor.uuid,
                monitor.userId ?? undefined
            );
        } catch (err) {
            log.warning(`[MONITOR] check-completed webhook failed: ${err}`);
        }
    }
}

/**
 * True when an extracted payload holds actual data: at least one non-null leaf
 * value. Catches the LLM extractor's no-data shapes — `{}`, `null`, and the
 * schema-skeleton object with every field null (buildEmptyDataFromSchema) —
 * which resolve without throwing and previously bypassed the
 * extraction-failure guard, producing false "field removed" alerts.
 */
function hasExtractedData(extracted: any): boolean {
    if (extracted === undefined || extracted === null) return false;
    if (Array.isArray(extracted)) return extracted.some((item) => hasExtractedData(item));
    if (typeof extracted === "object") {
        return Object.values(extracted).some((value) => hasExtractedData(value));
    }
    return true;
}

/** Human-readable JS shape label for shape-drift warnings. */
function describeShape(value: any): string {
    return Array.isArray(value) ? "array" : typeof value;
}
