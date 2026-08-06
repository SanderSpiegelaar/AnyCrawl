import { describe, expect, it, beforeAll } from "@jest/globals";
import { TemplateClient } from "../client/index.js";
import type { TemplateConfig } from "@anycrawl/libs";

/**
 * Unit tests for the L3 orchestrated handler-execution layer:
 * TemplateClient.runSeedHandler / runPageHandler.
 *
 * These use a trivial TRUSTED template whose handler source simply returns a
 * literal, so we exercise the sandbox + validator wiring without any DB, live
 * page, or billing side-effects.
 */
describe("Orchestrated handler execution (runSeedHandler / runPageHandler)", () => {
    let client: TemplateClient;

    const baseTemplate = (overrides: Partial<TemplateConfig> = {}): TemplateConfig => ({
        uuid: "orch-uuid-001",
        templateId: "orchestrated-test",
        name: "Orchestrated Test Template",
        description: "trivial trusted template for handler-layer tests",
        tags: ["test", "orchestrated"],
        version: "1.0.0",
        pricing: { perCall: 1, currency: "credits" },
        templateType: "scrape",
        reqOptions: { engine: "cheerio", formats: ["markdown"] } as any,
        metadata: { reviewStatus: "approved" },
        createdBy: "test-user",
        status: "published",
        reviewStatus: "approved",
        trusted: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    });

    beforeAll(() => {
        client = new TemplateClient();
    });

    it("runSeedHandler returns the raw author result", async () => {
        const template = baseTemplate({
            customHandlers: {
                seedHandler: {
                    enabled: true,
                    code: {
                        language: "javascript",
                        source: `return { seeds: [{ seedKey: "k1", url: "https://example.com/1", metadata: { page: 1 } }], warnings: [] };`,
                    },
                },
            },
        });

        const result = await client.runSeedHandler({
            templateConfig: template,
            variables: { foo: "bar" },
        });

        expect(result).toBeDefined();
        expect(result.seeds).toHaveLength(1);
        expect(result.seeds[0]).toEqual({
            seedKey: "k1",
            url: "https://example.com/1",
            metadata: { page: 1 },
        });
        expect(result.warnings).toEqual([]);
    });

    it("runSeedHandler can read injected variables", async () => {
        const template = baseTemplate({
            customHandlers: {
                seedHandler: {
                    enabled: true,
                    code: {
                        language: "javascript",
                        source: `return { seeds: [{ seedKey: variables.city, url: "https://example.com/" + variables.city }] };`,
                    },
                },
            },
        });

        const result = await client.runSeedHandler({
            templateConfig: template,
            variables: { city: "sfbay" },
        });

        expect(result.seeds[0]).toEqual({
            seedKey: "sfbay",
            url: "https://example.com/sfbay",
        });
    });

    it("runSeedHandler throws when seedHandler is missing/disabled", async () => {
        await expect(
            client.runSeedHandler({ templateConfig: baseTemplate(), variables: {} })
        ).rejects.toThrow(/no enabled seedHandler/);

        const disabled = baseTemplate({
            customHandlers: {
                seedHandler: {
                    enabled: false,
                    code: { language: "javascript", source: `return { seeds: [] };` },
                },
            },
        });
        await expect(
            client.runSeedHandler({ templateConfig: disabled, variables: {} })
        ).rejects.toThrow(/no enabled seedHandler/);
    });

    it("runPageHandler returns the raw author result and can read scrapeResult", async () => {
        const template = baseTemplate({
            customHandlers: {
                requestHandler: {
                    enabled: true,
                    code: {
                        language: "javascript",
                        source: `return { items: [{ id: 1, from: context.data.scrapeResult.url, mode: context.data.run.requestType }], nextUrl: null };`,
                    },
                },
            },
        });

        const result = await client.runPageHandler({
            templateConfig: template,
            variables: {},
            requestType: "list",
            scrapeResult: {
                url: "https://example.com/list?p=1",
                rawHtml: "<html><body>hi</body></html>",
            },
            context: { runId: "run-1", seedKey: "k1", pageIndex: 0, attempt: 1 },
        });

        expect(result).toBeDefined();
        expect(result.items).toEqual([
            { id: 1, from: "https://example.com/list?p=1", mode: "list" },
        ]);
        expect(result.nextUrl).toBeNull();
    });

    it("runPageHandler throws when requestHandler is missing/disabled", async () => {
        await expect(
            client.runPageHandler({
                templateConfig: baseTemplate(),
                variables: {},
                requestType: "list",
                scrapeResult: { url: "https://example.com" },
            })
        ).rejects.toThrow(/no enabled requestHandler/);
    });
});
