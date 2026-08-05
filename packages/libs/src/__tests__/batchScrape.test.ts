import { describe, expect, it } from "@jest/globals";
import { batchScrapeSchema } from "../types/BatchScrapeSchema.js";
import { estimateTaskCredits } from "../credits.js";

describe("batchScrapeSchema", () => {
    it("normalizes urls + shared options and applies defaults", () => {
        const parsed = batchScrapeSchema.parse({
            urls: ["https://a.com", "https://b.com"],
            formats: ["markdown", "html"],
        });
        expect(parsed.urls).toEqual(["https://a.com", "https://b.com"]);
        expect(parsed.engine).toBe("auto"); // default
        expect(parsed.ignore_invalid_urls).toBe(true); // default
        expect(parsed.options.formats).toEqual(["markdown", "html"]);
        expect(parsed.options.only_main_content).toBe(true); // default from base schema
    });

    it("rejects an empty urls array", () => {
        expect(() => batchScrapeSchema.parse({ urls: [] })).toThrow();
    });

    it("rejects unknown/extra option shapes gracefully (keeps only known options)", () => {
        const parsed = batchScrapeSchema.parse({
            urls: ["https://a.com"],
            engine: "cheerio",
            proxy: "stealth",
        });
        expect(parsed.engine).toBe("cheerio");
        expect(parsed.options.proxy).toBe("stealth");
    });
});

describe("estimateTaskCredits('batch_scrape')", () => {
    it("multiplies per-url credits by url count", () => {
        const payload = {
            urls: ["https://a.com", "https://b.com", "https://c.com"],
            options: { proxy: "auto", formats: ["markdown"] },
        };
        // base scrape = 1 credit per url, auto proxy adds 0 -> 3 urls * 1 = 3
        expect(estimateTaskCredits("batch_scrape", payload)).toBe(3);
    });

    it("accounts for stealth proxy surcharge per url", () => {
        const prevCredits = process.env.ANYCRAWL_PROXY_STEALTH_CREDITS;
        const prevUrl = process.env.ANYCRAWL_PROXY_STEALTH_URL;
        // Stealth surcharge only applies when a stealth proxy is actually configured.
        process.env.ANYCRAWL_PROXY_STEALTH_CREDITS = "2";
        process.env.ANYCRAWL_PROXY_STEALTH_URL = "http://stealth.example:8080";
        try {
            const payload = {
                urls: ["https://a.com", "https://b.com"],
                options: { proxy: "stealth", formats: ["markdown"] },
            };
            // (1 base + 2 stealth) * 2 urls = 6
            expect(estimateTaskCredits("batch_scrape", payload)).toBe(6);
        } finally {
            if (prevCredits === undefined) delete process.env.ANYCRAWL_PROXY_STEALTH_CREDITS;
            else process.env.ANYCRAWL_PROXY_STEALTH_CREDITS = prevCredits;
            if (prevUrl === undefined) delete process.env.ANYCRAWL_PROXY_STEALTH_URL;
            else process.env.ANYCRAWL_PROXY_STEALTH_URL = prevUrl;
        }
    });
});
