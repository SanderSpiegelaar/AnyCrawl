import { z } from "zod";
import { baseSchema } from "./BaseSchema.js";

/**
 * Absolute safety ceiling for the number of URLs accepted in a single batch scrape
 * request. The runtime-configurable soft limit (ANYCRAWL_BATCH_SCRAPE_MAX_URLS,
 * default 10000) is enforced in the controller so it can be tuned without a redeploy;
 * this hard cap only guards against pathological payloads that could exhaust memory.
 */
const HARD_MAX_URLS = 100_000;

// Reuse the shared scrape option fields from the base schema, but drop the single `url`
// (batch uses `urls`). All options are shared across every URL in the batch.
const pickedOptions = baseSchema.pick({
    template_id: true,
    variables: true,
    engine: true,
    proxy: true,
    formats: true,
    timeout: true,
    retry: true,
    wait_for: true,
    wait_until: true,
    wait_for_selector: true,
    include_tags: true,
    exclude_tags: true,
    only_main_content: true,
    json_options: true,
    extract_source: true,
    ocr_options: true,
    max_age: true,
    store_in_cache: true,
});

const batchInputSchema = pickedOptions.extend({
    /**
     * The list of URLs to scrape. Basic non-empty strings here; URL-format validation,
     * de-duplication and the configurable soft limit are applied in the controller so
     * that `ignore_invalid_urls` can be honoured and invalid entries reported back.
     */
    urls: z.array(z.string().min(1)).min(1).max(HARD_MAX_URLS),

    /**
     * When true (default), malformed URLs are skipped and returned in `invalid_urls`
     * instead of failing the whole request.
     */
    ignore_invalid_urls: z.boolean().default(true),
});

export const batchScrapeSchema = batchInputSchema.transform((data) => ({
    urls: data.urls,
    engine: data.engine,
    templateVariables: data.variables,
    ignore_invalid_urls: data.ignore_invalid_urls,
    options: {
        template_id: data.template_id,
        proxy: data.proxy,
        formats: data.formats,
        timeout: data.timeout,
        retry: data.retry,
        wait_for: data.wait_for,
        wait_until: data.wait_until,
        wait_for_selector: data.wait_for_selector,
        include_tags: data.include_tags,
        exclude_tags: data.exclude_tags,
        only_main_content: data.only_main_content,
        json_options: data.json_options,
        extract_source: data.extract_source,
        ocr_options: data.ocr_options,
        max_age: data.max_age,
        store_in_cache: data.store_in_cache,
    },
}));

export type BatchScrapeSchema = z.infer<typeof batchScrapeSchema>;

export const BatchScrapeJobInput = z.object({
    uuid: z.string().uuid(),
});
export type BatchScrapeJobInput = z.input<typeof BatchScrapeJobInput>;
