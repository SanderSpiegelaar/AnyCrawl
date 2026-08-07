import { CrawlingContext } from "crawlee";
import type { TemplateScrapeSchema, TemplateCrawlSchema, TemplateSearchSchema } from "./index.js";

/**
 * Domain restriction configuration for templates
 */
export interface DomainRestriction {
    type: "glob" | "exact";
    patterns: string[];
}

/**
 * Result of a domain/template validation check
 */
export interface DomainValidationResult {
    isValid: boolean;
    error?: string;
    code?: string;
}

/**
 * HTTP response structure used across packages
 */
export interface HttpResponse<T = any> {
    status: number;
    headers: Record<string, string>;
    data: T;
    rawText?: string;
}

// Template configuration types
export interface TemplateConfig {
    // Basic information
    uuid: string;
    templateId: string;
    // Optional vanity slug for human-friendly dedicated endpoints. Globally unique when set.
    slug?: string | null;
    name: string;
    description?: string;
    tags: string[];
    version: string;

    // Pricing information
    pricing: {
        perCall: number;
        currency: "credits";
    };

    // Template type - determines which operation this template supports
    templateType: "scrape" | "crawl" | "search";

    // Request options configuration - structure depends on templateType
    reqOptions: TemplateScrapeSchema | TemplateCrawlSchema | TemplateSearchSchema;

    // ---------------------------------------------------------------------
    // L3: Orchestrated runtime + output schema + revision pointer
    // All fields below are OPTIONAL and additive (see design doc §7.2, §8, §9).
    // ---------------------------------------------------------------------

    // Runtime capability declaration.
    // Absent runtime is treated as { mode: "single" } (Legacy Run Adapter).
    runtime?: TemplateRuntimeConfig;

    // Structured output schema for per-item Dataset writes / projections.
    // Absent outputSchema falls back to the standard result mapping (doc §6.3).
    outputSchema?: TemplateOutputSchema;

    // Pointer to the current immutable template_revisions row (doc §9.1).
    currentRevisionId?: string | null;

    // Custom handlers code
    customHandlers?: {
        // Pre-navigation capture rules for browser engines
        preNav?: Array<{
            key: string; // unique per request scope
            rules: Array<
                | { type: 'exact'; pattern: string }
                | { type: 'glob'; pattern: string }
                | { type: 'regex'; pattern: string }
            >;
        }>;
        // Query transformation for search templates
        queryTransform?: {
            enabled: boolean;
            mode: "template" | "append";
            template?: string;  // Template mode: use {{query}} placeholder, e.g. "site:abc.com {{query}}"
            prefix?: string;    // Append mode: prefix to add before query
            suffix?: string;    // Append mode: suffix to add after query
            // Optional: extract substring with regex before applying mode
            regexExtract?: {
                pattern: string; // e.g. ^(https?:\/\/www\.tiktok\.com\/@[^\/?#]+)
                flags?: string;  // e.g. "i"
                group?: number;  // default 0
                trim?: boolean;  // default true
            };
        };
        // URL transformation for scrape/crawl templates
        urlTransform?: {
            enabled: boolean;
            mode: "template" | "append";
            template?: string;  // Template mode: use {{url}} placeholder, e.g. "https://example.com?q={{url}}"
            prefix?: string;    // Append mode: prefix to add before url
            suffix?: string;    // Append mode: suffix to add after url
            // Optional: extract substring with regex before applying mode
            regexExtract?: {
                pattern: string; // e.g. ^(https?:\/\/www\.tiktok\.com\/@[^\/?#]+)
                flags?: string;  // e.g. "i"
                group?: number;  // default 0
                trim?: boolean;  // default true
            };
        };
        requestHandler?: {
            enabled: boolean;
            code: {
                language: "javascript" | "typescript";
                source: string;
                compiled?: string;
            };
        };
        // Orchestrated runtime: seed builder handler (doc §7.2). Mirrors the
        // requestHandler shape exactly; additive/optional. Absent/disabled in
        // single (legacy) mode.
        seedHandler?: {
            enabled: boolean;
            code: {
                language: "javascript" | "typescript";
                source: string;
                compiled?: string;
            };
        };
        failedRequestHandler?: {
            enabled: boolean;
            code: {
                language: "javascript" | "typescript";
                source: string;
                compiled?: string;
            };
        };
    };

    // Template metadata
    metadata: {
        reviewRcords?: [
            {
                reviewDate: Date;
                reviewStatus: "pending" | "approved" | "rejected";
                reviewNotes?: string;
                reviewUser?: string;
            }
        ],
        // Domain restrictions
        allowedDomains?: {
            type: "glob" | "exact";
            patterns: string[];
        };
        /**
         * **Search templates only.** When `false`, a search that uses `scrape_options.template_id` for
         * follow-up scrapes still runs those templates but does **not** charge scrape template
         * per-call credits (`search_result_scrape_template`). Engine scrape credits (`search_result_scrape`) still apply.
         * When omitted or `true`, scrape template pricing applies as usual.
         */
        charge_scrape_template_credits?: boolean;
        /**
         * Explicit override for the call-spec `inputs.url_mode` (design doc §5.6). When set to one
         * of the four valid values, it wins over the derived default in
         * `TemplateEndpointController.spec()`. Absent for every template today; only needed by
         * future templates that don't fit the "caller must supply url/query" default (e.g. a
         * fixed-URL template, or one where the caller may optionally override a generated seed URL).
         *   - "user": caller must supply `url`/`query` (today's universal default).
         *   - "fixed": template always scrapes a fixed URL; caller supplies nothing.
         *   - "generated": template assembles its own seed URL(s) (e.g. orchestrated seedHandler);
         *     caller supplies nothing.
         *   - "hybrid": template has a default/generated URL but the caller may optionally override it.
         */
        urlMode?: "user" | "fixed" | "generated" | "hybrid";
        [key: string]: any;
    };

    // Template variables
    variables?: {
        [key: string]: TemplateVariableDefinition;
    };

    // User information
    createdBy: string;
    publishedBy?: string;
    reviewedBy?: string;

    // Status information
    status: "draft" | "pending" | "approved" | "rejected" | "published" | "archived";
    reviewStatus: "pending" | "approved" | "rejected";
    reviewNotes?: string;

    // Security
    trusted: boolean; // If true, can use AsyncFunction with page object; if false, must use VM sandbox

    // Timestamps
    createdAt: Date;
    updatedAt: Date;
    publishedAt?: Date;
    reviewedAt?: Date;
    archivedAt?: Date;
}

export interface TemplateVariableMapping {
    target: string;
    mode?: "replace";
}

// ---------------------------------------------------------------------------
// L3 contract types (design doc §7.2 runtime, §8 variables/outputSchema, §9 revisions)
// ---------------------------------------------------------------------------

/**
 * Scalar variable types supported for both top-level variables and array element
 * shapes. `array` is only valid at the top level (see `TemplateVariableDefinition`).
 */
export type TemplateVariableScalarType = "string" | "number" | "boolean" | "url" | "enum";

/**
 * Top-level variable types. Adds `array` to the historical scalar set so
 * templates can declare `string[]` / `enum[]` variables (doc §8).
 */
export type TemplateVariableType = TemplateVariableScalarType | "array";

/**
 * Element type / shape for `array` variables (e.g. Craigslist `cities` = `enum[]`,
 * `searchQueries` = `string[]`).
 */
export interface TemplateVariableItems {
    type: TemplateVariableScalarType;
    // For enum element types, the allowed values (either `enum` or `values`).
    enum?: Array<string | number | boolean>;
    values?: Array<string | number | boolean>;
    // Or provide labeled options; `value` is used for validation.
    options?: Array<{ label: string; value: string | number | boolean }>;
}

/**
 * A single template variable definition. Backward compatible with the historical
 * inline shape; `array`, `items`, `enum`, and the numeric/length constraints are
 * additive (doc §8).
 */
export interface TemplateVariableDefinition {
    type: TemplateVariableType;
    label?: string;
    description: string;
    required: boolean;
    defaultValue?: any;
    // For enum type variables, define allowed values.
    values?: Array<string | number | boolean>;
    // Alias for `values` accepted by the §9 validation contract.
    enum?: Array<string | number | boolean>;
    // Or provide labeled options; `value` is used for validation.
    options?: Array<{ label: string; value: string | number | boolean }>;
    // For `array` variables: element type / shape (doc §8: string[], enum[]).
    items?: TemplateVariableItems;
    // Numeric range constraints for `number` variables (doc §8: min <= max).
    min?: number;
    max?: number;
    // Length constraints for `array` variables.
    minItems?: number;
    maxItems?: number;
    mapping?: TemplateVariableMapping;
}

/**
 * Runtime capability declaration (doc §7.2 / §8). Absent runtime is treated as
 * `{ mode: "single" }` by the Legacy Run Adapter.
 */
export interface TemplateRuntimeConfig {
    mode: "single" | "orchestrated";
    // Page/seed handler protocol version, e.g. "1".
    handlerProtocolVersion?: string;
    // Orchestrated mode points at the enabled `customHandlers.seedHandler`;
    // single mode is null/absent.
    seedBuilder?: { type: "handler"; name: string } | null;
    // Template-declared default run options (bounded by platform hard caps).
    defaultRunOptions?: Record<string, unknown>;
}

/**
 * Projection type for a structured output field, mirrored by the Dataset
 * typed-value columns (doc §11.7).
 */
export type TemplateProjectionType = "string" | "number" | "boolean" | "timestamptz";

/**
 * A single filterable/sortable projection declared by an output schema.
 * `path` is an RFC 6901 JSON Pointer relative to each item.
 */
export interface TemplateOutputProjection {
    field: string;
    path: string;
    type: TemplateProjectionType;
}

/**
 * Structured output schema (doc §8). `itemsPath`, `itemKeyPath`, and
 * `hashExcludePaths` use RFC 6901 JSON Pointers.
 */
export interface TemplateOutputSchema {
    name: string;
    version: string;
    // JSON Pointer to the array of items within the handler result.
    itemsPath?: string;
    // JSON Pointer to the stable key, relative to each item.
    itemKeyPath?: string;
    // JSON Pointers excluded from the Dataset document hash (e.g. volatile timestamps).
    hashExcludePaths?: string[];
    projections?: TemplateOutputProjection[];
}

/**
 * Immutable template revision snapshot (doc §9.1 `template_revisions`).
 */
export interface TemplateRevision {
    uuid: string;
    templateUuid: string;
    version: string;
    configHash: string;
    configSnapshot: unknown;
    schemaSnapshot: unknown;
    createdAt: Date;
}

// Template client configuration
export interface TemplateClientConfig {
    cacheConfig?: {
        ttl: number; // Cache time-to-live in milliseconds
        maxSize: number; // Maximum number of cached templates
        cleanupInterval: number; // Cleanup interval in milliseconds
    };
    sandboxConfig?: {
        timeout: number; // Execution timeout in milliseconds
        memoryLimit: number; // Memory limit in MB
        maxWorkers: number; // Maximum number of worker threads
    };
}

// Template execution context
export interface TemplateExecutionContext {
    templateId: string;
    variables?: Record<string, any>;
    userData?: Record<string, any>;
    request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: any;
    };
    response?: CrawlingContext['response'];
    metadata?: Record<string, any>;
    scrapeResult?: {
        url?: string;
        title?: string;
        markdown?: string;
        html?: string;
        text?: string;
        screenshot?: string;
        "screenshot@fullPage"?: string;
        rawHtml?: string;
        json?: any;
        [key: string]: any;
    };
}

// Template execution result
export interface TemplateExecutionResult {
    success: boolean;
    data?: any;
    error?: string;
    logs?: Array<{ level: string; ts: number; message: string }>;
    executionTime: number;
    creditsCharged: number;
    metadata?: Record<string, any>;
}

// Template filters for querying
export interface TemplateFilters {
    tags?: string[];
    status?: string;
    reviewStatus?: string;
    createdBy?: string;
    difficulty?: string;
    search?: string;
    limit?: number;
    offset?: number;
}

// Template list response
export interface TemplateListResponse {
    templates: TemplateConfig[];
    total: number;
    limit: number;
    offset: number;
}

// Cache entry
export interface CachedTemplate {
    template: TemplateConfig;
    timestamp: number;
}

// Sandbox execution context
export interface SandboxContext {
    template: TemplateConfig;
    executionContext: TemplateExecutionContext;
    variables: Record<string, any>;
    page?: any; // Page object from browser engines (Playwright/Puppeteer)
}

// Error types
export class TemplateError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = "TemplateError";
    }
}

export class TemplateNotFoundError extends TemplateError {
    constructor(templateId: string) {
        super(`Template not found: ${templateId}`, "TEMPLATE_NOT_FOUND");
    }
}

export class TemplateExecutionError extends TemplateError {
    constructor(message: string, public originalError?: Error) {
        super(message, "TEMPLATE_EXECUTION_ERROR");
    }
}

export class TemplateValidationError extends TemplateError {
    constructor(message: string, code: string = "TEMPLATE_VALIDATION_ERROR") {
        super(message, code);
        this.name = "TemplateValidationError";
    }
}

export class SandboxError extends TemplateError {
    constructor(message: string) {
        super(message, "SANDBOX_ERROR");
    }
}