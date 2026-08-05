import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
    BatchScrapeAndWaitResult,
    BatchScrapeJobResponse,
    BatchScrapeRequest,
    BatchScrapeResultsResponse,
    BatchScrapeStatus,
    BatchScrapeStatusResponse,
} from '../types.js';
import { unwrapApiResponse, sleep } from '../utils/index.js';

/**
 * Build the flat request body for a batch scrape. Options are shared across every URL
 * and forwarded at the top level (same shape as single scrape), with `url` -> `urls`.
 */
function buildBatchBody(input: BatchScrapeRequest): Record<string, unknown> {
    const body: any = { urls: input.urls, engine: input.engine ?? 'auto' };
    if (input.ignore_invalid_urls != null) body.ignore_invalid_urls = input.ignore_invalid_urls;
    if (input.template_id != null) body.template_id = input.template_id;
    if (input.variables != null) body.variables = input.variables;
    if (input.proxy != null) body.proxy = input.proxy;
    if (input.formats != null) body.formats = input.formats;
    if (input.timeout != null) body.timeout = input.timeout;
    if (input.retry != null) body.retry = input.retry;
    if (input.wait_for != null) body.wait_for = input.wait_for;
    if (input.wait_until != null) body.wait_until = input.wait_until;
    if (input.wait_for_selector != null) body.wait_for_selector = input.wait_for_selector;
    if (input.include_tags != null) body.include_tags = input.include_tags;
    if (input.exclude_tags != null) body.exclude_tags = input.exclude_tags;
    if (input.only_main_content != null) body.only_main_content = input.only_main_content;
    if (input.json_options != null) body.json_options = input.json_options;
    if (input.extract_source != null) body.extract_source = input.extract_source;
    if (input.ocr_options != null) body.ocr_options = input.ocr_options;
    if (input.max_age != null) body.max_age = input.max_age;
    if (input.store_in_cache != null) body.store_in_cache = input.store_in_cache;
    return body;
}

export async function createBatchScrape(
    client: AxiosInstance,
    input: BatchScrapeRequest
): Promise<BatchScrapeJobResponse> {
    const response: AxiosResponse<unknown> = await client.post('/v1/batch/scrape', buildBatchBody(input));
    return unwrapApiResponse<BatchScrapeJobResponse>(response.data, 'Batch scrape creation failed');
}

export async function getBatchScrapeStatus(
    client: AxiosInstance,
    jobId: string
): Promise<BatchScrapeStatusResponse> {
    const response: AxiosResponse<any> = await client.get(`/v1/batch/scrape/${jobId}/status`);
    const payload: any = response.data;
    if (!payload.success) throw new Error(payload.error || 'Failed to get batch scrape status');
    return payload.data as BatchScrapeStatusResponse;
}

export async function getBatchScrapeResults(
    client: AxiosInstance,
    jobId: string,
    skip: number = 0
): Promise<BatchScrapeResultsResponse> {
    const safeSkip = Math.max(0, Math.floor(Number(skip) || 0));
    const response: AxiosResponse<any> = await client.get(`/v1/batch/scrape/${jobId}?skip=${safeSkip}`);
    const raw = response.data;
    if (!raw || raw.success === false) {
        throw new Error((raw?.error ?? raw?.message) || 'Failed to get batch scrape results');
    }
    return {
        ...raw,
        creditsUsed: raw.credits_used ?? raw.creditsUsed ?? 0,
    } as BatchScrapeResultsResponse;
}

/**
 * Create a batch scrape and block until it finishes, then return all aggregated results.
 */
export async function batchScrapeAndWait(
    client: AxiosInstance,
    input: BatchScrapeRequest,
    pollIntervalSeconds: number = 2,
    timeoutMs?: number
): Promise<BatchScrapeAndWaitResult> {
    const started = await createBatchScrape(client, input);
    const jobId = started.job_id;

    const startedAt = Date.now();
    let finalStatus: BatchScrapeStatus = 'completed';

    while (true) {
        const status = await getBatchScrapeStatus(client, jobId);
        finalStatus = status.status;
        if (status.status === 'completed') break;
        if (status.status === 'failed') {
            throw new Error(`Batch scrape failed (job_id=${jobId})`);
        }
        if (status.status === 'cancelled') break;

        if (timeoutMs !== undefined && Date.now() - startedAt > timeoutMs) {
            throw new Error(`Batch scrape timed out after ${timeoutMs}ms (job_id=${jobId})`);
        }

        await sleep(pollIntervalSeconds);
    }

    const aggregated: any[] = [];
    let skip = 0;
    let total = 0;
    let completed = 0;
    let failed = 0;
    let creditsUsed = 0;
    while (true) {
        const page = await getBatchScrapeResults(client, jobId, skip);
        if (typeof page.total === 'number') total = page.total;
        if (typeof page.completed === 'number') completed = page.completed;
        if (typeof page.failed === 'number') failed = page.failed;
        if (typeof page.creditsUsed === 'number') creditsUsed = page.creditsUsed;

        if (Array.isArray(page.data) && page.data.length > 0) {
            aggregated.push(...page.data);
        }

        if (page.next) {
            skip = aggregated.length;
        } else {
            break;
        }
    }

    return {
        job_id: jobId,
        status: finalStatus,
        total,
        completed,
        failed,
        creditsUsed,
        data: aggregated,
    };
}
