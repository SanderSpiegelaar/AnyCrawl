import type { AxiosInstance, AxiosResponse } from 'axios';
import type { TemplateExecuteRequest, TemplateExecuteResult, TemplateSpec } from '../types.js';
import { unwrapApiResponse } from '../utils/index.js';

/**
 * Execute a template via its dedicated endpoint.
 *
 * POST /v1/template/{ref}/execute
 *
 * `ref` is a vanity slug (preferred) or the templateId. Only `url`, `query` and
 * `variables` are accepted in the body — every other option comes from the template
 * itself. The result shape depends on the template type:
 *   - scrape  -> ScrapeResult
 *   - search  -> SearchResult[]
 *   - crawl   -> CrawlJobResponse ({ job_id, status, message }) — poll /v1/crawl/{job_id}
 */
export async function executeTemplate(
    client: AxiosInstance,
    ref: string,
    input: TemplateExecuteRequest = {}
): Promise<TemplateExecuteResult> {
    const body: any = {};
    if (input.url != null) body.url = input.url;
    if (input.query != null) body.query = input.query;
    if (input.variables != null) body.variables = input.variables;
    const response: AxiosResponse<unknown> = await client.post(
        `/v1/template/${encodeURIComponent(ref)}/execute`,
        body
    );
    return unwrapApiResponse<TemplateExecuteResult>(response.data, 'Template execution failed');
}

/**
 * Fetch a template's redacted call-spec (discovery).
 *
 * GET /v1/template/{ref}
 *
 * Describes the template's inputs, pricing and endpoint without exposing internal
 * handlers. This call is free (never billed).
 */
export async function getTemplateSpec(client: AxiosInstance, ref: string): Promise<TemplateSpec> {
    const response: AxiosResponse<unknown> = await client.get(
        `/v1/template/${encodeURIComponent(ref)}`
    );
    return unwrapApiResponse<TemplateSpec>(response.data, 'Failed to get template spec');
}
