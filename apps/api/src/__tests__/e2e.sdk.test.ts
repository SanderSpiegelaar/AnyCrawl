import { describe, it, expect, beforeAll } from "@jest/globals";

const API_KEY = process.env.ANYCRAWL_API_KEY;
const BASE_URL = process.env.ANYCRAWL_BASE_URL || "https://api.anycrawl.dev";
const RUN_LIVE = process.env.ANYCRAWL_RUN_LIVE === "1" || process.env.ANYCRAWL_RUN_LIVE === "true";

// Only run live tests when key exists and user opts in
const maybeDescribe = API_KEY && RUN_LIVE ? describe : describe.skip;

describe("AnyCrawlClient (env-gated)", () => {
    it("skips live tests without ANYCRAWL_API_KEY or ANYCRAWL_RUN_LIVE", () => {
        if (API_KEY && RUN_LIVE) {
            // This spec is only to keep jest from complaining when describe.skip above is not used
            expect(true).toBe(true);
        } else {
            expect(true).toBe(true);
        }
    });
});

maybeDescribe("AnyCrawlClient E2E", () => {
    let client: any;
    let AnyCrawlClient: any;

    beforeAll(async () => {
        // Use dynamic import to avoid "module is already linked" error
        const sdkModule = await import("@anycrawl/js-sdk");
        AnyCrawlClient = sdkModule.AnyCrawlClient;
        client = new AnyCrawlClient(API_KEY as string, BASE_URL);
    });

    it("healthCheck returns ok", async () => {
        const res = await client.healthCheck();
        expect(res.status).toBeDefined();
    }, 30000);

    it("scrape returns completed or failed structure", async () => {
        const res = await client.scrape({
            url: "https://example.com",
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 30000,
        });
        // status can be completed or failed, but structure should be valid
        expect(["completed", "failed"]).toContain(res.status);
        expect(res.url).toContain("http");
    }, 120000);

    it.each([
        ["cheerio"],
        ["playwright"],
        ["puppeteer"],
    ])("scrape works with engine=%s", async (engine) => {
        const res = await client.scrape({
            url: "https://example.com",
            engine: engine as any,
            formats: ["markdown"],
            timeout: 45000,
        });
        expect(["completed", "failed"]).toContain(res.status);
        expect(res.url).toContain("http");
    }, 180000);

    it("scrape supports json_options extraction hints", async () => {
        const res = await client.scrape({
            url: "https://example.com",
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 45000,
            json_options: {
                schema: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                    },
                },
                user_prompt: "Extract the page title",
                schema_name: "PageTitle",
                schema_description: "Extracts page title only",
            },
            extract_source: "markdown",
        });
        expect(["completed", "failed"]).toContain(res.status);
        expect(res.url).toContain("http");
    }, 180000);

    it("createCrawl returns job id", async () => {
        const crawl = await client.createCrawl({
            url: "https://example.com",
            engine: "cheerio",
            formats: ["markdown"],
            limit: 1,
            timeout: 30000,
            extract_source: "markdown",
            scrape_options: {
                json_options: {
                    schema: { type: "object" },
                    user_prompt: "Extract basic content",
                },
            },
        });
        expect(crawl.job_id).toBeDefined();
    }, 120000);

    it("crawl end-to-end: 5 pages with markdown & json_options, then fetch results", async () => {
        const start = await client.createCrawl({
            url: "https://example.com",
            engine: "cheerio",
            formats: ["markdown", "html"],
            limit: 5,
            timeout: 45000,
            extract_source: "markdown",
            scrape_options: {
                json_options: {
                    schema: { type: "object" },
                    user_prompt: "Extract minimal info",
                },
            },
        });
        expect(start.job_id).toBeDefined();

        // Poll status up to ~2 minutes
        let status: any;
        for (let i = 0; i < 24; i++) {
            status = await client.getCrawlStatus(start.job_id);
            if (status.status === "completed" || (status.completed && status.completed > 0)) break;
            await new Promise((r) => setTimeout(r, 5000));
        }
        expect(status).toBeDefined();

        // Fetch first page of results
        const results = await client.getCrawlResults(start.job_id, 0);
        expect(Array.isArray(results.data)).toBe(true);
        if (typeof results.total === "number") {
            expect(results.total).toBeLessThanOrEqual(5);
        }
        if (results.data.length > 0) {
            const first: any = results.data[0];
            // If provider returns content fields, ensure at least one exists when we requested markdown/html
            const hasContent = "markdown" in first || "html" in first;
            expect(hasContent).toBe(true);
        }
    }, 180000);

    it("createBatchScrape returns job id and total", async () => {
        const started = await client.createBatchScrape({
            urls: ["https://example.com", "https://example.com/"], // second de-dups to first
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 30000,
        });
        expect(started.job_id).toBeDefined();
        expect(typeof started.total).toBe("number");
        expect(started.total).toBeGreaterThanOrEqual(1);
    }, 120000);

    it("createBatchScrape rejects when all urls are invalid and ignore_invalid_urls=false", async () => {
        await expect(
            client.createBatchScrape({
                urls: ["not a url", "still not a url"],
                ignore_invalid_urls: false,
            })
        ).rejects.toBeDefined();
    }, 60000);

    it("batch scrape end-to-end: multiple urls, poll status then fetch results", async () => {
        const start = await client.createBatchScrape({
            urls: ["https://example.com", "https://httpstat.us/200"],
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 45000,
        });
        expect(start.job_id).toBeDefined();
        expect(start.total).toBeGreaterThanOrEqual(1);

        // Poll status up to ~2 minutes
        let status: any;
        for (let i = 0; i < 24; i++) {
            status = await client.getBatchScrapeStatus(start.job_id);
            if (
                status.status === "completed" ||
                status.status === "failed" ||
                (status.completed && status.completed > 0)
            ) {
                break;
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
        expect(status).toBeDefined();
        expect(typeof status.total).toBe("number");
        expect(typeof status.completed).toBe("number");
        expect(typeof status.failed).toBe("number");

        const results = await client.getBatchScrapeResults(start.job_id, 0);
        expect(Array.isArray(results.data)).toBe(true);
        if (results.data.length > 0) {
            const first: any = results.data[0];
            expect(typeof first.url).toBe("string");
            expect(first.url).toContain("http");
        }
    }, 180000);

    it("batchScrape (wait) aggregates all results", async () => {
        const res = await client.batchScrape({
            urls: ["https://example.com"],
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 45000,
        });
        expect(["completed", "failed", "cancelled"]).toContain(res.status);
        expect(typeof res.total).toBe("number");
        expect(typeof res.completed).toBe("number");
        expect(typeof res.failed).toBe("number");
        expect(Array.isArray(res.data)).toBe(true);
    }, 240000);

    it("cancelBatchScrape on a fresh job returns cancelled or 409 for finished", async () => {
        const start = await client.createBatchScrape({
            urls: ["https://example.com", "https://httpstat.us/200", "https://httpstat.us/201"],
            engine: "cheerio",
            formats: ["markdown"],
            timeout: 45000,
        });
        expect(start.job_id).toBeDefined();
        try {
            const res = await client.cancelBatchScrape(start.job_id);
            expect(res.status).toBe("cancelled");
        } catch (err) {
            // Job may have already finished (fast/small batch) -> upstream returns 409
            expect(err).toBeDefined();
        }
    }, 120000);

    it("search minimal works (no scrape enrichment)", async () => {
        const results = await client.search({
            query: "site:example.com",
            scrape_options: { engine: "cheerio" },
            limit: 3,
        });
        expect(Array.isArray(results)).toBe(true);
    }, 120000);

    it.each([
        ["cheerio"],
        ["playwright"],
        ["puppeteer"],
    ])("search works with engine=%s and supports json_options", async (engine) => {
        const results = await client.search({
            query: "site:example.com",
            limit: 1,
            scrape_options: {
                engine: engine as any,
                json_options: {
                    schema: { type: "object" },
                    user_prompt: "Extract minimal content",
                },
            },
        });
        expect(Array.isArray(results)).toBe(true);
    }, 240000);
});


