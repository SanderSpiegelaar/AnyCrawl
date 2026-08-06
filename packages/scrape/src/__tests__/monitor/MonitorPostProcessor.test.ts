import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
// Real (unmocked) pure helpers so we can precompute hashes for the "same" case.
import { normalizeContent, hashContent } from "../../monitor/normalize.js";

/**
 * Integration test for MonitorPostProcessor.
 *
 * All I/O boundaries are mocked (DB, AI, Webhook, Email, judge) but the real
 * normalize + diff + classify orchestration runs, so this verifies the actual
 * decision path: snapshot → diff → classify → change record → webhook event.
 */

// --- Captured state, reset per test ---
let inserted: Record<string, any[]>;
let updated: Array<{ table: any; values: any }>;
let webhookEvents: Array<{ eventType: string; payload: any; source: string; sourceId: string }>;
let monitorConfig: any;
let prevSnapshot: any;
let jobResults: any[];
// Configurable mock behaviors
let llmExtractImpl: () => Promise<any>;
let emailImpl: () => Promise<any>;
let emailCalls: number;

// Distinguishable table markers (schemas mock)
const schemas = {
    jobs: "jobs",
    taskExecutions: "task_executions",
    monitors: "monitors",
    monitorSnapshots: "monitor_snapshots",
    monitorChanges: "monitor_changes",
    scheduledTasks: "scheduled_tasks",
};

function makeDb() {
    return {
        select: (_projection?: any) => ({
            from: (table: any) => ({
                where: () => ({
                    limit: async () => {
                        if (table === schemas.jobs) return [{ jobId: "job-1" }];
                        if (table === schemas.taskExecutions) return [{ jobUuid: "job-uuid-1" }];
                        return [];
                    },
                }),
            }),
        }),
        insert: (table: any) => ({
            values: async (v: any) => {
                (inserted[table] = inserted[table] || []).push(v);
            },
        }),
        update: (table: any) => ({
            set: (values: any) => ({
                where: async () => {
                    updated.push({ table, values });
                },
            }),
        }),
    };
}

// --- ESM module mocks (must precede dynamic import of the SUT) ---
jest.unstable_mockModule("@anycrawl/db", () => ({
    getDB: async () => makeDb(),
    schemas,
    eq: (..._a: any[]) => ({}),
    sql: (..._a: any[]) => ({}),
    getMonitorByScheduledTask: async () => monitorConfig,
    getLatestSnapshot: async () => prevSnapshot,
    getJobResults: async () => jobResults,
}));

jest.unstable_mockModule("@anycrawl/ai", () => ({
    LLMExtract: class {
        async perform() {
            return llmExtractImpl();
        }
    },
    getExtractModelId: () => "test-model",
}));

// Note: jest.unstable_mockModule resolves relative specifiers from the package
// root (jest.setup.js / rootDir), NOT the test file. Paths are therefore given
// relative to packages/scrape; they resolve to the same absolute modules the SUT
// imports, so the mocks apply.
jest.unstable_mockModule("./src/managers/Webhook.js", () => ({
    WebhookManager: {
        getInstance: () => ({
            triggerEvent: async (eventType: string, payload: any, source: string, sourceId: string) => {
                webhookEvents.push({ eventType, payload, source, sourceId });
                // Contract: triggerEvent returns the number of deliveries enqueued;
                // 0 means nothing dispatched and must not count as delivered.
                return 1;
            },
        }),
    },
}));

jest.unstable_mockModule("./src/monitor/judge.js", () => ({
    judgeChange: async () => ({ meaningful: true, confidence: "high", reason: "test" }),
}));

jest.unstable_mockModule("./src/monitor/EmailNotifier.js", () => ({
    EmailNotifier: {
        sendChangeEmail: async () => {
            emailCalls++;
            return emailImpl();
        },
    },
}));

// Dynamic import AFTER mocks are registered
const { MonitorPostProcessor } = await import("../../monitor/MonitorPostProcessor.js");

describe("MonitorPostProcessor (integration)", () => {
    const origWebhooks = process.env.ANYCRAWL_WEBHOOKS_ENABLED;
    const origSmtpHost = process.env.ANYCRAWL_SMTP_HOST;

    beforeEach(() => {
        process.env.ANYCRAWL_WEBHOOKS_ENABLED = "true";
        delete process.env.ANYCRAWL_SMTP_HOST; // email disabled
        inserted = {};
        updated = [];
        webhookEvents = [];
        prevSnapshot = null;
        jobResults = [];
        monitorConfig = null;
        llmExtractImpl = async () => ({ data: {} });
        emailImpl = async () => {};
        emailCalls = 0;
    });

    afterEach(() => {
        if (origWebhooks === undefined) delete process.env.ANYCRAWL_WEBHOOKS_ENABLED;
        else process.env.ANYCRAWL_WEBHOOKS_ENABLED = origWebhooks;
        if (origSmtpHost === undefined) delete process.env.ANYCRAWL_SMTP_HOST;
        else process.env.ANYCRAWL_SMTP_HOST = origSmtpHost;
    });

    it("detects a price increase and fires monitor.price.changed", async () => {
        monitorConfig = {
            uuid: "mon-1",
            name: "Competitor Pricing",
            monitorType: "price",
            trackMode: "json",
            goal: "Alert on price changes",
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH",
            content: "Price: $19",
            extracted: { price: 19 },
        };
        jobResults = [
            { url: "https://x.com/pricing", data: { markdown: "Price: $24", json: { price: 24 } } },
        ];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-1",
            executionUuid: "exec-1",
            jobUuid: "job-uuid-1",
        });

        // A snapshot was written with status "changed"
        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("changed");
        expect(snaps[0].extracted).toEqual({ price: 24 });

        // A change was recorded, classified price_up with the field diff
        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(changes[0].changeType).toBe("price_up");
        expect(changes[0].diffJson).toEqual([
            { path: "price", from: 19, to: 24, delta: 5 },
        ]);

        // Webhook: one price.changed + one check.completed summary
        const priceEvent = webhookEvents.find((e) => e.eventType === "monitor.price.changed");
        expect(priceEvent).toBeDefined();
        expect(priceEvent!.payload.change_type).toBe("price_up");
        expect(priceEvent!.payload.url).toBe("https://x.com/pricing");
        expect(priceEvent!.source).toBe("monitor");

        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.changed).toBe(1);

        // Webhook delivered → the change is marked notified
        const notifiedUpdates = updated.filter(
            (u) => u.table === schemas.monitorChanges && u.values.notified === true
        );
        expect(notifiedUpdates).toHaveLength(1);
    });

    it("detects a text change on a webpage monitor and fires monitor.changed", async () => {
        monitorConfig = {
            uuid: "mon-2",
            name: "Docs Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = { uuid: "snap-0", contentHash: "OLD_HASH", content: "Version 1.0", extracted: null };
        jobResults = [{ url: "https://x.com/docs", data: { markdown: "Version 2.0" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-2",
            executionUuid: "exec-2",
            jobUuid: "job-uuid-1",
        });

        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(changes[0].changeType).toBe("content");
        expect(changes[0].diffText).toContain("-Version 1.0");
        expect(changes[0].diffText).toContain("+Version 2.0");

        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(true);
        expect(webhookEvents.some((e) => e.eventType === "monitor.price.changed")).toBe(false);
    });

    it("does not fire change events when content is unchanged", async () => {
        const markdown = "Stable content that does not change";
        const normalized = normalizeContent({ markdown });
        monitorConfig = {
            uuid: "mon-3",
            name: "Stable Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        // Previous snapshot hash matches current → status "same"
        prevSnapshot = { uuid: "snap-0", contentHash: hashContent(normalized), content: normalized, extracted: null };
        jobResults = [{ url: "https://x.com/stable", data: { markdown } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-3",
            executionUuid: "exec-3",
            jobUuid: "job-uuid-1",
        });

        // Snapshot written as "same", no change records
        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("same");
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);

        // Only the check-completed summary fires, with changed=0
        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(false);
        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.changed).toBe(0);
    });

    it("is a no-op for non-monitor scheduled tasks", async () => {
        monitorConfig = null; // getMonitorByScheduledTask returns nothing
        await MonitorPostProcessor.process({
            scheduledTaskUuid: "not-a-monitor",
            executionUuid: "exec-x",
            jobUuid: "job-uuid-1",
        });
        expect(inserted[schemas.monitorSnapshots] || []).toHaveLength(0);
        expect(webhookEvents).toHaveLength(0);
    });

    it("first check establishes a baseline without firing change events", async () => {
        monitorConfig = {
            uuid: "mon-4",
            name: "New Monitor",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"], only_meaningful: true },
            userId: "user-1",
        };
        prevSnapshot = null; // no prior snapshot → status "new"
        jobResults = [{ url: "https://x.com/new", data: { markdown: "First capture" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-4",
            executionUuid: "exec-4",
            jobUuid: "job-uuid-1",
        });

        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0].status).toBe("new");
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);
        expect(webhookEvents.some((e) => e.eventType === "monitor.changed")).toBe(false);
    });

    it("records an error snapshot instead of a false 'all removed' alert when extraction fails", async () => {
        monitorConfig = {
            uuid: "mon-5",
            name: "Pricing (LLM down)",
            monitorType: "price",
            trackMode: "json",
            goal: null,
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"] },
            userId: "user-1",
        };
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH",
            content: "Price: $19",
            extracted: { price: 19, currency: "USD" },
        };
        // Scrape result has no data.json and the fallback LLM extraction fails
        jobResults = [{ url: "https://x.com/pricing", data: { markdown: "Price page (rendered without prices)" } }];
        llmExtractImpl = async () => {
            throw new Error("LLM upstream 500");
        };

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-5",
            executionUuid: "exec-5",
            jobUuid: "job-uuid-1",
        });

        // Snapshot written directly as 'error' (guard runs BEFORE the insert, so
        // a crash can never leave a changed/same snapshot with null extracted as
        // the next baseline)
        const snaps = inserted[schemas.monitorSnapshots] || [];
        expect(snaps).toHaveLength(1);
        expect(snaps[0]!.status).toBe("error");
        const statusUpdates = updated.filter((u) => u.table === schemas.monitorSnapshots);
        expect(statusUpdates).toHaveLength(0);

        // No change record, no change/price webhook — no false "removed" alert
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);
        expect(
            webhookEvents.some(
                (e) => e.eventType === "monitor.changed" || e.eventType === "monitor.price.changed"
            )
        ).toBe(false);

        // Counters moved from 'changed' to 'error' in the summary
        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.error).toBe(1);
        expect(summary!.payload.summary.changed).toBe(0);
        expect(summary!.payload.summary.same).toBe(0);
    });

    it.each([
        ["empty object", {}],
        ["all-null schema skeleton", { price: null, currency: null }],
        ["bare null", null],
    ])(
        "extraction 'succeeding' with no data (%s) is treated as extraction failure, not 'all removed'",
        async (_label, emptyPayload) => {
            monitorConfig = {
                uuid: "mon-5c",
                name: "Pricing (empty extraction)",
                monitorType: "price",
                trackMode: "json",
                goal: null,
                extractSchema: { type: "object" },
                diffOptions: {},
                notifyOptions: { channels: ["webhook"] },
                userId: "user-1",
            };
            prevSnapshot = {
                uuid: "snap-0",
                contentHash: "OLD_HASH",
                content: "Price: $19",
                extracted: { price: 19, currency: "USD" },
            };
            // The LLM extractor resolves WITHOUT throwing but returns a no-data
            // shape ({}, all-null skeleton, or null) — must hit the same guard
            // as a throwing extraction, not diff prev vs empty.
            jobResults = [
                { url: "https://x.com/pricing", data: { markdown: "Price page (rendered without prices)" } },
            ];
            llmExtractImpl = async () => ({ data: emptyPayload });

            await MonitorPostProcessor.process({
                scheduledTaskUuid: "task-5",
                executionUuid: "exec-5c",
                jobUuid: "job-uuid-1",
            });

            const snaps = inserted[schemas.monitorSnapshots] || [];
            expect(snaps).toHaveLength(1);
            expect(snaps[0]!.status).toBe("error");
            expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);
            expect(
                webhookEvents.some(
                    (e) => e.eventType === "monitor.changed" || e.eventType === "monitor.price.changed"
                )
            ).toBe(false);
        }
    );

    it("json-mode shape drift (object -> array) does not throw and still records a change", async () => {
        monitorConfig = {
            uuid: "mon-5b",
            name: "Pricing (shape drift)",
            monitorType: "price",
            trackMode: "json",
            goal: null,
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"] },
            userId: "user-1",
        };
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH",
            content: "Price: $19",
            extracted: { price: 19 },
        };
        jobResults = [
            { url: "https://x.com/pricing", data: { markdown: "Price: $24", json: [{ price: 24 }] } },
        ];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-5b",
            executionUuid: "exec-5b",
            jobUuid: "job-uuid-1",
        });

        // Diff succeeded despite the shape mismatch → a change record exists
        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(Array.isArray(changes[0].diffJson)).toBe(true);
        expect(changes[0].diffJson.length).toBeGreaterThan(0);
    });

    it("mixed mode still alerts on json-only changes when the truncated text is identical", async () => {
        const markdown = "Plan: Pro";
        const normalized = normalizeContent({ markdown });
        monitorConfig = {
            uuid: "mon-6",
            name: "Mixed Monitor",
            monitorType: "price",
            trackMode: "mixed",
            goal: null,
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"] },
            userId: "user-1",
        };
        // Hash differs (e.g. change beyond the truncation boundary) but the
        // stored/truncated text is identical; the json payload changed.
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH",
            content: normalized,
            extracted: { price: 19 },
        };
        jobResults = [{ url: "https://x.com/pricing", data: { markdown, json: { price: 24 } } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-6",
            executionUuid: "exec-6",
            jobUuid: "job-uuid-1",
        });

        const changes = inserted[schemas.monitorChanges] || [];
        expect(changes).toHaveLength(1);
        expect(changes[0].changeType).toBe("price_up");
        expect(changes[0].diffText).toBeNull(); // no text diff to report
        expect(changes[0].diffJson).toEqual([{ path: "price", from: 19, to: 24, delta: 5 }]);
        expect(webhookEvents.some((e) => e.eventType === "monitor.price.changed")).toBe(true);
    });

    it("mixed mode downgrades to 'same' only when both text and json diffs are empty", async () => {
        const markdown = "Plan: Pro";
        const normalized = normalizeContent({ markdown });
        monitorConfig = {
            uuid: "mon-7",
            name: "Mixed Monitor (noise)",
            monitorType: "price",
            trackMode: "mixed",
            goal: null,
            extractSchema: { type: "object" },
            diffOptions: {},
            notifyOptions: { channels: ["webhook"] },
            userId: "user-1",
        };
        prevSnapshot = {
            uuid: "snap-0",
            contentHash: "OLD_HASH", // hash noise: differs, but content + json identical
            content: normalized,
            extracted: { price: 19 },
        };
        jobResults = [{ url: "https://x.com/pricing", data: { markdown, json: { price: 19 } } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-7",
            executionUuid: "exec-7",
            jobUuid: "job-uuid-1",
        });

        expect(inserted[schemas.monitorChanges] || []).toHaveLength(0);
        const statusUpdates = updated.filter((u) => u.table === schemas.monitorSnapshots);
        expect(statusUpdates).toHaveLength(1);
        expect(statusUpdates[0]!.values.status).toBe("same");

        const summary = webhookEvents.find((e) => e.eventType === "monitor.check.completed");
        expect(summary).toBeDefined();
        expect(summary!.payload.summary.changed).toBe(0);
        expect(summary!.payload.summary.same).toBe(1);
        expect(webhookEvents.some((e) => e.eventType === "monitor.price.changed")).toBe(false);
    });

    it("does not mark changes notified when no channel delivered", async () => {
        process.env.ANYCRAWL_WEBHOOKS_ENABLED = "false"; // webhooks globally off, email off
        monitorConfig = {
            uuid: "mon-8",
            name: "Docs Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["webhook"] },
            userId: "user-1",
        };
        prevSnapshot = { uuid: "snap-0", contentHash: "OLD_HASH", content: "Version 1.0", extracted: null };
        jobResults = [{ url: "https://x.com/docs", data: { markdown: "Version 2.0" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-8",
            executionUuid: "exec-8",
            jobUuid: "job-uuid-1",
        });

        // The change itself is still recorded…
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(1);
        // …but nothing was delivered, so it must stay notified: false
        const notifiedUpdates = updated.filter(
            (u) => u.table === schemas.monitorChanges && u.values.notified === true
        );
        expect(notifiedUpdates).toHaveLength(0);
    });

    it("does not mark notified when email delivery fails and no webhook fired", async () => {
        process.env.ANYCRAWL_WEBHOOKS_ENABLED = "false";
        process.env.ANYCRAWL_SMTP_HOST = "smtp.test"; // email channel enabled
        emailImpl = async () => {
            // Contract: sendChangeEmail throws when nothing was delivered
            throw new Error("SMTP connection refused");
        };
        monitorConfig = {
            uuid: "mon-9",
            name: "Docs Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["email"], email_recipients: ["ops@example.com"] },
            userId: "user-1",
        };
        prevSnapshot = { uuid: "snap-0", contentHash: "OLD_HASH", content: "Version 1.0", extracted: null };
        jobResults = [{ url: "https://x.com/docs", data: { markdown: "Version 2.0" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-9",
            executionUuid: "exec-9",
            jobUuid: "job-uuid-1",
        });

        expect(emailCalls).toBe(1);
        expect(inserted[schemas.monitorChanges] || []).toHaveLength(1);
        const notifiedUpdates = updated.filter(
            (u) => u.table === schemas.monitorChanges && u.values.notified === true
        );
        expect(notifiedUpdates).toHaveLength(0);
    });

    it("marks notified when email delivers even with webhooks disabled", async () => {
        process.env.ANYCRAWL_WEBHOOKS_ENABLED = "false";
        process.env.ANYCRAWL_SMTP_HOST = "smtp.test";
        monitorConfig = {
            uuid: "mon-10",
            name: "Docs Page",
            monitorType: "webpage",
            trackMode: "text",
            goal: null,
            extractSchema: null,
            diffOptions: {},
            notifyOptions: { channels: ["email"], email_recipients: ["ops@example.com"] },
            userId: "user-1",
        };
        prevSnapshot = { uuid: "snap-0", contentHash: "OLD_HASH", content: "Version 1.0", extracted: null };
        jobResults = [{ url: "https://x.com/docs", data: { markdown: "Version 2.0" } }];

        await MonitorPostProcessor.process({
            scheduledTaskUuid: "task-10",
            executionUuid: "exec-10",
            jobUuid: "job-uuid-1",
        });

        expect(emailCalls).toBe(1);
        const notifiedUpdates = updated.filter(
            (u) => u.table === schemas.monitorChanges && u.values.notified === true
        );
        expect(notifiedUpdates).toHaveLength(1);
    });
});
