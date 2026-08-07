import { jest, describe, it, expect, beforeEach } from "@jest/globals";

/**
 * Unit test for the L3 OrchestratedRunner (the `template-run` worker body).
 *
 * Every I/O boundary is mocked — TemplateClient (seed + page handlers), the
 * request-ledger + run DB fns, the Dataset Writer, and the fetch (QueueManager +
 * job-result read) — but the real orchestration runs: seed expansion → ledger
 * enqueue → sequential drain → pagination via nextUrl → item streaming → cap
 * enforcement → finalize. This verifies the actual control flow, not the mocks.
 */

// ---------------------------------------------------------------------------
// Test-controlled state, reset per test.
// ---------------------------------------------------------------------------
let ledger: any[];
let seq: number;
let seedHandlerImpl: () => Promise<any>;
let pageResponses: any[];
let pageHandlerCalls: number;
let validateDomainImpl: (tpl: any, url: string) => { isValid: boolean; error?: string };
let writeCalls: any[];
let finalizeCalls: any[];
let enqueueCalls: any[];
let events: Array<{ type: string; payload: any }>;
let runStatus: string;
let jobResultData: any;

const schemas = { runWarnings: "run_warnings" };

// ---------------------------------------------------------------------------
// Mock: @anycrawl/template-client — seed + page handlers + domain validation.
// ---------------------------------------------------------------------------
jest.unstable_mockModule("@anycrawl/template-client", () => ({
    TemplateClient: class {
        async runSeedHandler() {
            return seedHandlerImpl();
        }
        async runPageHandler() {
            const resp = pageResponses[pageHandlerCalls] ?? { items: [], nextUrl: null };
            pageHandlerCalls++;
            return resp;
        }
        validateDomainRestrictions(tpl: any, url: string) {
            return validateDomainImpl(tpl, url);
        }
    },
}));

// ---------------------------------------------------------------------------
// Mock: @anycrawl/db — in-memory request ledger + run lifecycle + writer.
// ---------------------------------------------------------------------------
jest.unstable_mockModule("@anycrawl/db", () => ({
    getTemplateRevision: async () => ({
        uuid: "rev-1",
        version: "1.0.0",
        configSnapshot: {
            templateId: "craigslist-all-in-one",
            templateType: "scrape",
            trusted: true,
            customHandlers: {
                seedHandler: { enabled: true, code: { source: "return {seeds:[]}" } },
                requestHandler: { enabled: true, code: { source: "return {items:[]}" } },
            },
            metadata: { allowedDomains: { type: "glob", patterns: ["*.craigslist.org"] } },
            runtime: { mode: "orchestrated" },
        },
        schemaSnapshot: null,
        createdAt: new Date(),
    }),
    getTemplateRun: async () => ({ status: runStatus }),
    updateTemplateRunStatus: async () => ({ status: "running" }),
    finalizeTemplateRun: async (_uuid: string, terminal: string, extras: any) => {
        finalizeCalls.push({ terminal, extras });
        return { status: terminal };
    },
    appendTemplateRunEvent: async (_runId: string, type: string, payload: any) => {
        events.push({ type, payload });
        return {};
    },
    enqueueTemplateRunRequest: async (p: any) => {
        enqueueCalls.push(p);
        // Emulate uq_template_run_request (run, request_key): a repeat is a no-op.
        const existing = ledger.find((r) => r.requestKey === p.requestKey);
        if (existing) return existing;
        const row = {
            uuid: `req-${++seq}`,
            status: p.status ?? "queued",
            seedKey: p.seedKey ?? null,
            seedIndex: p.seedIndex ?? null,
            pageIndex: p.pageIndex ?? null,
            normalizedUrl: p.normalizedUrl,
            requestKey: p.requestKey,
        };
        ledger.push(row);
        return row;
    },
    claimNextTemplateRunRequest: async () => {
        const r = ledger.find((x) => x.status === "queued");
        if (!r) return null;
        r.status = "running";
        return r;
    },
    updateTemplateRunRequestStatus: async (uuid: string, patch: any) => {
        const r = ledger.find((x) => x.uuid === uuid);
        if (r) Object.assign(r, patch);
        return r ?? null;
    },
    countTemplateRunRequestsByStatus: async () => {
        const out: Record<string, number> = {};
        for (const r of ledger) out[r.status] = (out[r.status] ?? 0) + 1;
        return out;
    },
    writeResultToDataset: async (p: any) => {
        writeCalls.push(p);
        const n = p.result?.items?.length ?? 0;
        return {
            datasetId: "d1",
            datasetRunId: "dr1",
            status: "running",
            itemsSeen: n,
            itemsCreated: n,
            itemsUpdated: 0,
            itemsUnchanged: 0,
            warnings: [],
        };
    },
    createJob: async () => { },
    getJobResults: async () => [{ url: "https://sfbay.craigslist.org/page", status: "success", data: jobResultData }],
    getDB: async () => ({
        insert: () => ({ values: async () => { } }),
    }),
    schemas,
}));

// ---------------------------------------------------------------------------
// Mock: ../managers/Queue.js — the scrape-queue fetch handshake. Path is given
// relative to the package root (rootDir), matching how OrchestratedRunner's
// "../managers/Queue.js" resolves.
//
// `waitJobDone` tracks concurrently in-flight fetches (inFlightFetches /
// maxInFlightFetches) and yields a macrotask before resolving. This lets the
// concurrency regression test below observe that >1 fetch is genuinely
// in-flight at once under a bounded worker pool — plain correctness
// assertions alone can't distinguish "true multiplexing" from "serialized,
// but the response happened to be reused across workers".
// ---------------------------------------------------------------------------
let addJobCount = 0;
let inFlightFetches = 0;
let maxInFlightFetches = 0;
jest.unstable_mockModule("./src/managers/Queue.js", () => ({
    QueueManager: {
        getInstance: () => ({
            addJob: async () => `scrape-job-${++addJobCount}`,
            waitJobDone: async () => {
                inFlightFetches++;
                maxInFlightFetches = Math.max(maxInFlightFetches, inFlightFetches);
                await new Promise((resolve) => setTimeout(resolve, 0));
                inFlightFetches--;
                return {};
            },
        }),
    },
}));

// Dynamic import AFTER mocks are registered.
const { OrchestratedRunner } = await import("../template/OrchestratedRunner.js");

function basePayload(overrides: any = {}): any {
    return {
        type: "template-run",
        runId: "run-1",
        templateRevisionId: "rev-1",
        templateUuid: "tpl-uuid-1",
        variables: { cities: ["sfbay"], categories: ["sss"] },
        runOptions: {},
        dataset: {
            datasetId: "ds-1",
            mapping: { name: "craigslist_listing", version: "1.0.0", itemsPath: "items", itemKeyPath: "id" },
            owner: { apiKeyId: "key-1", userId: "user-1" },
        },
        engine: "cheerio",
        ownerContext: { apiKeyId: "key-1", userId: "user-1" },
        ...overrides,
    };
}

describe("OrchestratedRunner", () => {
    beforeEach(() => {
        ledger = [];
        seq = 0;
        pageHandlerCalls = 0;
        pageResponses = [];
        writeCalls = [];
        finalizeCalls = [];
        enqueueCalls = [];
        events = [];
        runStatus = "running";
        addJobCount = 0;
        inFlightFetches = 0;
        maxInFlightFetches = 0;
        jobResultData = { rawHtml: "<html></html>", markdown: "# page" };
        validateDomainImpl = () => ({ isValid: true });
        seedHandlerImpl = async () => ({
            seeds: [{ seedKey: "s1", url: "https://sfbay.craigslist.org/search/sss" }],
        });
    });

    it("expands a seed, paginates a 2-page seed to drain, streams items, finalizes completed", async () => {
        pageResponses = [
            {
                items: [{ id: "1", url: "https://sfbay.craigslist.org/1.html", title: "a" }],
                nextUrl: "https://sfbay.craigslist.org/search/sss?s=120",
            },
            {
                items: [{ id: "2", url: "https://sfbay.craigslist.org/2.html", title: "b" }],
                nextUrl: null,
            },
        ];

        await new OrchestratedRunner().run(basePayload());

        // Seed page + one paginated nextUrl page were enqueued, both drained.
        expect(ledger).toHaveLength(2);
        expect(ledger.every((r) => r.status === "completed")).toBe(true);
        expect(ledger.map((r) => r.pageIndex)).toEqual([1, 2]);

        // The page handler ran once per page, then claimNext returned null.
        expect(pageHandlerCalls).toBe(2);

        // Items streamed to the Dataset Writer, one write per page, ordered pageIndex.
        expect(writeCalls).toHaveLength(2);
        expect(writeCalls[0].result.items).toHaveLength(1);
        expect(writeCalls[0].producerType).toBe("template-run");
        expect(writeCalls[0].scopeType).toBe("orchestrated");
        expect(writeCalls[0].finalizeRun).toBe(false);
        expect(writeCalls.map((c) => c.pageIndex)).toEqual([0, 1]);

        // Finalized completed with full-coverage statistics.
        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("completed");
        expect(finalizeCalls[0].extras.stopReason).toBe("completed");
        expect(finalizeCalls[0].extras.statistics).toMatchObject({
            pages_fetched: 2,
            items_found: 2,
            items_returned: 2,
            coverage_complete: true,
        });
    });

    it("stops dispatch when max_items is reached (no further page enqueued)", async () => {
        pageResponses = [
            {
                items: [{ id: "1", url: "https://sfbay.craigslist.org/1.html", title: "a" }],
                // Would normally paginate, but max_items caps dispatch first.
                nextUrl: "https://sfbay.craigslist.org/search/sss?s=120",
            },
        ];

        await new OrchestratedRunner().run(basePayload({ runOptions: { max_items: 1 } }));

        // Only the seed page exists; the nextUrl page was never enqueued.
        expect(ledger).toHaveLength(1);
        expect(pageHandlerCalls).toBe(1);
        expect(writeCalls).toHaveLength(1);

        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("completed");
        expect(finalizeCalls[0].extras.stopReason).toBe("max_items_reached");
        expect(finalizeCalls[0].extras.statistics.coverage_complete).toBe(false);
        expect(finalizeCalls[0].extras.statistics.items_returned).toBe(1);
    });

    it("fails the run (no dispatch) when the seed count exceeds max_seeds", async () => {
        seedHandlerImpl = async () => ({
            seeds: [
                { seedKey: "s1", url: "https://sfbay.craigslist.org/search/sss" },
                { seedKey: "s2", url: "https://nyc.craigslist.org/search/sss" },
            ],
        });

        await new OrchestratedRunner().run(basePayload({ runOptions: { max_seeds: 1 } }));

        expect(enqueueCalls).toHaveLength(0);
        expect(ledger).toHaveLength(0);
        expect(writeCalls).toHaveLength(0);
        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("failed");
        expect(finalizeCalls[0].extras.errorCode).toBe("seed_limit_exceeded");
    });

    it("rejects a seed URL outside the allowed domain (warns, skips, no enqueue)", async () => {
        seedHandlerImpl = async () => ({
            seeds: [{ seedKey: "s1", url: "https://evil.example.com/search/sss" }],
        });
        validateDomainImpl = (_tpl, url) =>
            url.includes("craigslist.org") ? { isValid: true } : { isValid: false, error: "domain not allowed" };

        await new OrchestratedRunner().run(basePayload());

        // Nothing enqueued or fetched; the run drains empty and finalizes completed
        // but without full coverage (a planned seed was rejected).
        expect(enqueueCalls).toHaveLength(0);
        expect(writeCalls).toHaveLength(0);
        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("completed");
        expect(finalizeCalls[0].extras.statistics.coverage_complete).toBe(false);
    });

    it("finalizes cancelled when the run is moved to cancelling mid-drain", async () => {
        runStatus = "cancelling";
        pageResponses = [{ items: [{ id: "1", url: "https://sfbay.craigslist.org/1.html", title: "a" }], nextUrl: null }];

        await new OrchestratedRunner().run(basePayload());

        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("cancelled");
        expect(finalizeCalls[0].extras.stopReason).toBe("cancelled");
        // The seed was enqueued but never processed (cancel checked before claim).
        expect(pageHandlerCalls).toBe(0);
        expect(writeCalls).toHaveLength(0);
    });

    it("drains multiple seeds concurrently when max_concurrency > 1 (bounded worker pool)", async () => {
        seedHandlerImpl = async () => ({
            seeds: [
                { seedKey: "s1", url: "https://sfbay.craigslist.org/search/sss" },
                { seedKey: "s2", url: "https://nyc.craigslist.org/search/sss" },
                { seedKey: "s3", url: "https://la.craigslist.org/search/sss" },
            ],
        });
        // Content is intentionally not paired to a specific seed: claim order
        // across concurrent workers is not deterministic, so which seed gets
        // which response index can vary. Assertions below use set-comparison
        // (by item id) rather than exact per-seed sequencing.
        pageResponses = [
            { items: [{ id: "a", url: "https://sfbay.craigslist.org/a.html", title: "a" }], nextUrl: null },
            { items: [{ id: "b", url: "https://nyc.craigslist.org/b.html", title: "b" }], nextUrl: null },
            { items: [{ id: "c", url: "https://la.craigslist.org/c.html", title: "c" }], nextUrl: null },
        ];

        await new OrchestratedRunner().run(basePayload({ runOptions: { max_concurrency: 2 } }));

        // All 3 seed pages were dispatched and completed exactly once — none
        // dropped, none double-claimed — regardless of which worker got which row.
        expect(ledger).toHaveLength(3);
        expect(ledger.every((r) => r.status === "completed")).toBe(true);
        expect(pageHandlerCalls).toBe(3);

        // Proves genuine multiplexing (not just correctness under an
        // accidentally-serialized mock): at least 2 fetches were in flight
        // simultaneously, which the old concurrency=1 loop could never produce.
        expect(maxInFlightFetches).toBeGreaterThanOrEqual(2);

        // Items from every seed landed, order-independent.
        const allItemIds = writeCalls.flatMap((c) => c.result.items.map((it: any) => it.id)).sort();
        expect(allItemIds).toEqual(["a", "b", "c"]);

        // Shared accumulators (pagesFetched/itemsFound/itemsReturned) were not
        // corrupted by concurrent read-modify-write.
        expect(finalizeCalls).toHaveLength(1);
        expect(finalizeCalls[0].terminal).toBe("completed");
        expect(finalizeCalls[0].extras.stopReason).toBe("completed");
        expect(finalizeCalls[0].extras.statistics).toMatchObject({
            pages_fetched: 3,
            items_found: 3,
            items_returned: 3,
            coverage_complete: true,
        });
    });
});
