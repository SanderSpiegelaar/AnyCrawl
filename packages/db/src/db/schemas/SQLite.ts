import * as p from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export const apiKey = p.sqliteTable("api_key", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key value - must be unique
    key: p.text("key").notNull().unique(),
    // user uuid
    user: p.text("user"),
    // Display name for the API key
    name: p.text("name").default("default"),
    // Whether the key is currently active
    isActive: p.integer("is_active", { mode: "boolean" }).notNull().default(true),
    // User/system that created this key
    createdBy: p.integer("created_by").default(-1),
    // Available credit balance
    credits: p.integer("credits").notNull().default(0),
    // Timestamp when the key was created
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    // Timestamp of last API key usage
    lastUsedAt: p.integer("last_used_at", { mode: "timestamp" }),
    // Optional expiration timestamp
    expiresAt: p.integer("expires_at", { mode: "timestamp" }),
    // Allowed IP addresses whitelist (JSON array of IP addresses or CIDR ranges)
    allowedIps: p.text("allowed_ips", { mode: "json" }).$type<string[]>(),
    // Subscription tier for rate limiting (free, paid, etc.)
    subscriptionTier: p.text("subscription_tier").default("free").notNull(),
});

export const requestLog = p.sqliteTable("request_log", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that made the request
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.text("user_id"),
    // path that was called
    path: p.text("path").notNull(),
    // HTTP method used
    method: p.text("method").notNull(),
    // Response status code
    statusCode: p.integer("status_code").notNull(),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Request IP address
    ipAddress: p.text("ip_address"),
    // User agent string
    userAgent: p.text("user_agent"),
    // Request body
    requestPayload: p.text("request_payload", { mode: "json" }).$type<string[]>(),
    // Request header
    requestHeader: p.text("request_header", { mode: "json" }).$type<string[]>(),
    // Response body
    responseBody: p.text("response_body", { mode: "json" }).$type<string[]>(),
    // Response header
    responseHeader: p.text("response_header", { mode: "json" }).$type<string[]>(),
    // Success or not
    success: p.integer("success", { mode: "boolean" }).notNull().default(true),
    // create at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const billingLedger = p.sqliteTable("billing_ledger", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Billing ownership
    jobId: p.text("job_id").notNull(),
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // Billing metadata
    mode: p.text("mode").notNull(), // 'delta' | 'target'
    reason: p.text("reason").notNull(),
    idempotencyKey: p.text("idempotency_key").notNull().unique(),
    // Billing amount and usage snapshot
    charged: p.integer("charged").notNull(),
    beforeUsed: p.integer("before_used").notNull(),
    afterUsed: p.integer("after_used").notNull(),
    // Itemized charge details (nullable for historical rows)
    chargeDetails: p.text("charge_details", { mode: "json" }).$type<Record<string, unknown>>(),
    // Credits snapshot (nullable when unavailable)
    beforeCredits: p.integer("before_credits"),
    afterCredits: p.integer("after_credits"),
    // Timestamp
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const jobs = p.sqliteTable("jobs", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job id
    jobId: p.text("job_id").notNull(),
    // job type
    jobType: p.text("job_type").notNull(),
    // job queue name
    jobQueueName: p.text("job_queue_name").notNull(),
    // job expire at
    jobExpireAt: p.integer("job_expire_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date(Date.now() + 3 * 60 * 60 * 1000)),
    // url
    url: p.text("url").notNull(),
    // payload from job
    payload: p.text("payload", { mode: "json" }).$type<string[]>(),
    // api key
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user or api_key.uuid)
    userId: p.text("user_id"),
    // total urls/pages found
    total: p.integer("total").notNull().default(0),
    // completed urls/pages
    completed: p.integer("completed").notNull().default(0),
    // failed urls/pages
    failed: p.integer("failed").notNull().default(0),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Credit deduction timestamp (null = not yet deducted, set when deduction completes)
    deductedAt: p.integer("deducted_at", { mode: "timestamp" }),
    // Number of cache hits recorded for this job
    cacheHits: p.integer("cache_hits").notNull().default(0),
    // Network traffic usage (application layer bytes)
    trafficBytes: p.integer("traffic_bytes").notNull().default(0),
    trafficRequestBytes: p.integer("traffic_request_bytes").notNull().default(0),
    trafficResponseBytes: p.integer("traffic_response_bytes").notNull().default(0),
    trafficRequestCount: p.integer("traffic_request_count").notNull().default(0),
    // Origin, playground or api
    origin: p.text("origin").notNull(),
    // status of job
    status: p.text("status").notNull(),
    // job success or not
    isSuccess: p.integer("is_success", { mode: "boolean" }).notNull().default(false),
    // job error message
    errorMessage: p.text("error_message"),
    // job created at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    // job updated at
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const jobResults = p.sqliteTable("job_results", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job uuid
    jobUuid: p.text("job_uuid").notNull().references(() => jobs.uuid),
    // url
    url: p.text("url").notNull(),
    // data
    data: p.text("data", { mode: "json" }).$type<string[]>(),
    // status
    status: p.text("status").notNull(),
    // created at
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    // updated at
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Template system tables
export const templates = p.sqliteTable("templates", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Template ID (business identifier)
    templateId: p.text("template_id").notNull().unique(),
    // Vanity slug for human-friendly dedicated endpoints (e.g. /v1/template/{slug}/execute).
    // Nullable + globally unique; templates without a slug are addressed by templateId only.
    slug: p.text("slug").unique(),
    // Template name
    name: p.text("name").notNull(),
    // Template description
    description: p.text("description"),
    // Template tags (JSON array)
    tags: p.text("tags", { mode: "json" }).notNull(),
    // Template version
    version: p.text("version").notNull().default("1.0.0"),
    // Template type - determines which operation this template supports
    templateType: p.text("template_type").notNull().default("scrape"),
    // Pricing information (JSON): { perCall: number, currency: "credits" }
    pricing: p.text("pricing", { mode: "json" }).notNull(),
    // Request options configuration (JSON) - supports scrape, crawl, and search
    reqOptions: p.text("req_options", { mode: "json" }).notNull(),
    // Custom handlers code (JSON)
    customHandlers: p.text("custom_handlers", { mode: "json" }),
    // Template metadata (JSON)
    metadata: p.text("metadata", { mode: "json" }).notNull(),
    // Template variables (JSON): { [key: string]: { type: string, description: string, required: boolean, defaultValue?: any } }
    variables: p.text("variables", { mode: "json" }),
    // User information
    createdBy: p.text("created_by").notNull(),
    publishedBy: p.text("published_by"),
    reviewedBy: p.text("reviewed_by"),
    // Status fields
    status: p.text("status").default("draft").notNull(),
    reviewStatus: p.text("review_status").default("pending").notNull(),
    reviewNotes: p.text("review_notes"),
    // Trusted flag - if true, can use AsyncFunction with page object; if false, must use VM sandbox
    trusted: p.integer("trusted", { mode: "boolean" }).notNull().default(false),
    // Timestamps
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    publishedAt: p.integer("published_at", { mode: "timestamp" }),
    reviewedAt: p.integer("reviewed_at", { mode: "timestamp" }),
    archivedAt: p.integer("archived_at", { mode: "timestamp" }),
});

export const templateExecutions = p.sqliteTable("template_executions", {
    // Primary key with auto-incrementing ID
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Foreign key to templates
    templateUuid: p.text("template_uuid").notNull().references(() => templates.uuid),
    // API key that made the request
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.text("user_id"),
    // Job information
    jobUuid: p.text("job_uuid").references(() => jobs.uuid),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsCharged: p.integer("credits_charged").default(0).notNull(),
    // Success or not
    success: p.integer("success", { mode: "boolean" }).notNull(),
    // Error message if failed
    errorMessage: p.text("error_message"),
    // Timestamp
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Scheduled Tasks and Webhooks tables
export const scheduledTasks = p.sqliteTable("scheduled_tasks", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this task
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.text("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    taskType: p.text("task_type").notNull(),
    taskPayload: p.text("task_payload", { mode: "json" }).notNull(),
    cronExpression: p.text("cron_expression").notNull(),
    timezone: p.text("timezone").default("UTC").notNull(),
    concurrencyMode: p.text("concurrency_mode").default("skip").notNull(),
    maxExecutionsPerDay: p.integer("max_executions_per_day"),
    minCreditsRequired: p.integer("min_credits_required").default(1).notNull(),
    isActive: p.integer("is_active", { mode: "boolean" }).default(true).notNull(),
    isPaused: p.integer("is_paused", { mode: "boolean" }).default(false).notNull(),
    pauseReason: p.text("pause_reason"),
    lastExecutionAt: p.integer("last_execution_at", { mode: "timestamp" }),
    nextExecutionAt: p.integer("next_execution_at", { mode: "timestamp" }),
    totalExecutions: p.integer("total_executions").default(0).notNull(),
    successfulExecutions: p.integer("successful_executions").default(0).notNull(),
    failedExecutions: p.integer("failed_executions").default(0).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    tags: p.text("tags", { mode: "json" }),
    metadata: p.text("metadata", { mode: "json" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const taskExecutions = p.sqliteTable("task_executions", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    scheduledTaskUuid: p.text("scheduled_task_uuid").notNull().references(() => scheduledTasks.uuid, { onDelete: "cascade" }),
    executionNumber: p.integer("execution_number").notNull(),
    idempotencyKey: p.text("idempotency_key").notNull().unique(),
    status: p.text("status").default("pending").notNull(),
    startedAt: p.integer("started_at", { mode: "timestamp" }),
    completedAt: p.integer("completed_at", { mode: "timestamp" }),
    jobUuid: p.text("job_uuid").references(() => jobs.uuid),
    // Note: creditsUsed, itemsProcessed, itemsSucceeded, itemsFailed, durationMs
    // are retrieved from jobs table via JOIN - removed to avoid data duplication
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    errorDetails: p.text("error_details", { mode: "json" }),
    triggeredBy: p.text("triggered_by").default("scheduler").notNull(),
    scheduledFor: p.integer("scheduled_for", { mode: "timestamp" }).notNull(),
    metadata: p.text("metadata", { mode: "json" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const webhookSubscriptions = p.sqliteTable("webhook_subscriptions", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this webhook
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.text("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    webhookUrl: p.text("webhook_url").notNull(),
    webhookSecret: p.text("webhook_secret").notNull(),
    scope: p.text("scope").default("all").notNull(),
    specificTaskIds: p.text("specific_task_ids", { mode: "json" }),
    eventTypes: p.text("event_types", { mode: "json" }).notNull(),
    customHeaders: p.text("custom_headers", { mode: "json" }),
    timeoutSeconds: p.integer("timeout_seconds").default(10).notNull(),
    maxRetries: p.integer("max_retries").default(3).notNull(),
    retryBackoffMultiplier: p.real("retry_backoff_multiplier").default(2).notNull(),
    isActive: p.integer("is_active", { mode: "boolean" }).default(true).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    autoDisableAfterFailures: p.integer("auto_disable_after_failures").default(10).notNull(),
    lastSuccessAt: p.integer("last_success_at", { mode: "timestamp" }),
    lastFailureAt: p.integer("last_failure_at", { mode: "timestamp" }),
    totalDeliveries: p.integer("total_deliveries").default(0).notNull(),
    successfulDeliveries: p.integer("successful_deliveries").default(0).notNull(),
    failedDeliveries: p.integer("failed_deliveries").default(0).notNull(),
    tags: p.text("tags", { mode: "json" }),
    metadata: p.text("metadata", { mode: "json" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const webhookDeliveries = p.sqliteTable("webhook_deliveries", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    webhookSubscriptionUuid: p.text("webhook_subscription_uuid").notNull().references(() => webhookSubscriptions.uuid, { onDelete: "cascade" }),
    eventType: p.text("event_type").notNull(),
    eventSource: p.text("event_source").notNull(),
    eventSourceId: p.text("event_source_id").notNull(),
    status: p.text("status").default("pending").notNull(),
    attemptNumber: p.integer("attempt_number").default(1).notNull(),
    maxAttempts: p.integer("max_attempts").default(3).notNull(),
    requestUrl: p.text("request_url").notNull(),
    requestMethod: p.text("request_method").default("POST").notNull(),
    requestHeaders: p.text("request_headers", { mode: "json" }),
    requestBody: p.text("request_body", { mode: "json" }),
    responseStatus: p.integer("response_status"),
    responseHeaders: p.text("response_headers", { mode: "json" }),
    responseBody: p.text("response_body"),
    responseDurationMs: p.integer("response_duration_ms"),
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    nextRetryAt: p.integer("next_retry_at", { mode: "timestamp" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    deliveredAt: p.integer("delivered_at", { mode: "timestamp" }),
});

// Cache tables for storing scraped page data
export const pageCache = p.sqliteTable("page_cache", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // URL information
    url: p.text("url").notNull(),
    urlHash: p.text("url_hash").notNull(),
    domain: p.text("domain").notNull(),
    // S3 storage reference
    s3Key: p.text("s3_key").notNull(),
    contentHash: p.text("content_hash"),
    // Metadata
    title: p.text("title"),
    description: p.text("description"),
    statusCode: p.integer("status_code").notNull(),
    contentType: p.text("content_type"),
    contentLength: p.integer("content_length"),
    // Options hash for cache key matching
    optionsHash: p.text("options_hash").notNull(),
    // Scrape configuration snapshot
    engine: p.text("engine"),
    isMobile: p.integer("is_mobile", { mode: "boolean" }).default(false),
    hasProxy: p.integer("has_proxy", { mode: "boolean" }).default(false),
    hasScreenshot: p.integer("has_screenshot", { mode: "boolean" }).default(false),
    // Timestamps
    scrapedAt: p.integer("scraped_at", { mode: "timestamp" }).notNull(),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const mapCache = p.sqliteTable("map_cache", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Domain information
    domain: p.text("domain").notNull(),
    domainHash: p.text("domain_hash").notNull(),
    // Discovered URLs
    urls: p.text("urls", { mode: "json" }).notNull().$type<Array<{ url: string; title?: string; description?: string }>>(),
    urlCount: p.integer("url_count").notNull(),
    // Source of discovery
    source: p.text("source").notNull(), // 'sitemap' | 'search' | 'crawl'
    // Timestamps
    discoveredAt: p.integer("discovered_at", { mode: "timestamp" }).notNull(),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Monitor tables — web change / price monitoring built on top of scheduled_tasks
export const monitors = p.sqliteTable("monitors", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Owner
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    userId: p.text("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    // 'webpage' | 'price'
    monitorType: p.text("monitor_type").default("webpage").notNull(),
    // Underlying scheduled task that drives the recurring scrape (1:1)
    scheduledTaskUuid: p.text("scheduled_task_uuid").references(() => scheduledTasks.uuid, { onDelete: "cascade" }),
    // [{ url, engine, options, location? }]
    targets: p.text("targets", { mode: "json" }).notNull(),
    // Natural-language judge criterion (optional)
    goal: p.text("goal"),
    // 'text' | 'json' | 'mixed'
    trackMode: p.text("track_mode").default("text").notNull(),
    // JSON schema used for structured (price) extraction
    extractSchema: p.text("extract_schema", { mode: "json" }),
    // { ignoreSelectors?, onlyMainContent?, minChangeRatio? }
    diffOptions: p.text("diff_options", { mode: "json" }),
    // { channels, emailRecipients?, onlyMeaningful?, thresholds? }
    notifyOptions: p.text("notify_options", { mode: "json" }),
    isActive: p.integer("is_active", { mode: "boolean" }).default(true).notNull(),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const monitorSnapshots = p.sqliteTable("monitor_snapshots", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    monitorUuid: p.text("monitor_uuid").notNull().references(() => monitors.uuid, { onDelete: "cascade" }),
    taskExecutionUuid: p.text("task_execution_uuid").references(() => taskExecutions.uuid),
    url: p.text("url").notNull(),
    // sha256 of normalized content
    contentHash: p.text("content_hash").notNull(),
    // Inlined normalized content (truncated); large content moves to S3 later
    content: p.text("content"),
    // Structured extraction result (price mode)
    extracted: p.text("extracted", { mode: "json" }),
    // 'new' | 'same' | 'changed' | 'removed' | 'error'
    status: p.text("status").notNull(),
    capturedAt: p.integer("captured_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const monitorChanges = p.sqliteTable("monitor_changes", {
    uuid: p
        .text("uuid")
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    monitorUuid: p.text("monitor_uuid").notNull().references(() => monitors.uuid, { onDelete: "cascade" }),
    url: p.text("url").notNull(),
    fromSnapshotUuid: p.text("from_snapshot_uuid"),
    toSnapshotUuid: p.text("to_snapshot_uuid"),
    // 'content' | 'price_up' | 'price_down' | 'stock' | 'new' | 'removed'
    changeType: p.text("change_type").notNull(),
    diffText: p.text("diff_text"),
    // [{ path, from, to, delta? }]
    diffJson: p.text("diff_json", { mode: "json" }),
    // { meaningful, confidence, reason }
    judgment: p.text("judgment", { mode: "json" }),
    notified: p.integer("notified", { mode: "boolean" }).default(false).notNull(),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ============================================================================
// Dataset (L2) tables — SQLite parallel of platform §11 / dedicated §5.9.
// Type substitutions: uuid->text, jsonb->text{json}, timestamp->integer{timestamp},
// boolean->integer{boolean}, numeric->real. Same table/column/index names as PostgreSQL.
// ============================================================================

export const datasets = p.sqliteTable("datasets", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    apiKey: p.text("api_key_id").references(() => apiKey.uuid),
    userId: p.text("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    sourceType: p.text("source_type").notNull(),
    sourceTemplateId: p.text("source_template_id"),
    sourceTemplateRevisionUuid: p.text("source_template_revision_uuid"),          // [RESERVED per R2]
    schemaName: p.text("schema_name").notNull(),
    schemaVersion: p.text("schema_version").notNull(),
    retentionPolicy: p.text("retention_policy", { mode: "json" }).$type<{ item_days?: number; change_days?: number }>(),
    itemCount: p.integer("item_count").notNull().default(0),
    activeItemCount: p.integer("active_item_count").notNull().default(0),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
    deletedAt: p.integer("deleted_at", { mode: "timestamp" }),
}, (t) => [
    p.index("ix_datasets_user_created").on(t.userId, t.createdAt, t.uuid).where(sql`${t.deletedAt} IS NULL`),
    p.index("ix_datasets_apikey_created").on(t.apiKey, t.createdAt, t.uuid).where(sql`${t.deletedAt} IS NULL`),
]);

export const datasetRuns = p.sqliteTable("dataset_runs", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.text("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    producerType: p.text("producer_type").notNull(),
    producerId: p.text("producer_id").notNull(),
    jobUuid: p.text("job_uuid").references(() => jobs.uuid),
    scheduledTaskUuid: p.text("scheduled_task_uuid").references(() => scheduledTasks.uuid),   // [RESERVED per R2]
    templateRunUuid: p.text("template_run_uuid"),                                             // [RESERVED per R2]
    scopeKey: p.text("scope_key").notNull(),
    status: p.text("status").notNull(),
    coverageComplete: p.integer("coverage_complete", { mode: "boolean" }).notNull().default(false),
    itemsSeen: p.integer("items_seen").notNull().default(0),
    itemsCreated: p.integer("items_created").notNull().default(0),
    itemsUpdated: p.integer("items_updated").notNull().default(0),
    itemsUnchanged: p.integer("items_unchanged").notNull().default(0),
    itemsRemoved: p.integer("items_removed").notNull().default(0),
    warningCount: p.integer("warning_count").notNull().default(0),
    warningSummary: p.text("warning_summary", { mode: "json" }).$type<Array<{ code: string; count: number }>>(),
    startedAt: p.integer("started_at", { mode: "timestamp" }),
    finishedAt: p.integer("finished_at", { mode: "timestamp" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_run_producer").on(t.datasetId, t.producerType, t.producerId),
    p.index("ix_dataset_run_job").on(t.jobUuid),
    p.index("ix_dataset_run_scheduled_task").on(t.scheduledTaskUuid),
    p.index("ix_dataset_run_template_run").on(t.templateRunUuid),
    p.index("ix_dataset_run_scope").on(t.datasetId, t.scopeKey, t.status),
]);

export const datasetItems = p.sqliteTable("dataset_items", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.text("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    sourceType: p.text("source_type").notNull(),
    sourceUrl: p.text("source_url"),
    document: p.text("document", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    documentHash: p.text("document_hash").notNull(),
    firstSeenAt: p.integer("first_seen_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: p.integer("last_seen_at", { mode: "timestamp" }).notNull(),
    isActive: p.integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_item").on(t.datasetId, t.itemKey),
    p.index("ix_dataset_item_cursor").on(t.datasetId, t.lastSeenAt, t.uuid),
]);

export const datasetRunItems = p.sqliteTable("dataset_run_items", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetRunId: p.text("dataset_run_id").notNull().references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    datasetItemId: p.text("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    sequence: p.integer("sequence"),
    seedKey: p.text("seed_key"),
    seedIndex: p.integer("seed_index"),
    pageIndex: p.integer("page_index"),
    position: p.integer("position"),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_run_item").on(t.datasetRunId, t.itemKey),
    p.uniqueIndex("uq_dataset_run_item_sequence").on(t.datasetRunId, t.sequence).where(sql`${t.sequence} IS NOT NULL`),
    p.index("ix_dataset_run_item_seq").on(t.datasetRunId, t.sequence),
    p.index("ix_dataset_run_item_occurrence").on(t.datasetRunId, t.seedIndex, t.pageIndex, t.position),
    p.index("ix_dataset_run_item_item").on(t.datasetItemId),
]);

export const datasetItemScopes = p.sqliteTable("dataset_item_scopes", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.text("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    datasetItemId: p.text("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    scopeKey: p.text("scope_key").notNull(),
    firstSeenAt: p.integer("first_seen_at", { mode: "timestamp" }).notNull(),
    lastSeenAt: p.integer("last_seen_at", { mode: "timestamp" }).notNull(),
    isActive: p.integer("is_active", { mode: "boolean" }).notNull().default(true),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_item_scope").on(t.datasetId, t.itemKey, t.scopeKey),
    p.index("ix_dataset_item_scope_recon").on(t.datasetId, t.scopeKey, t.isActive),
    p.index("ix_dataset_item_scope_item").on(t.datasetItemId),
]);

export const datasetItemChanges = p.sqliteTable("dataset_item_changes", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.text("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    datasetRunId: p.text("dataset_run_id").notNull().references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    datasetItemId: p.text("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    scopeKey: p.text("scope_key").notNull(),
    changeType: p.text("change_type").notNull(),
    beforeHash: p.text("before_hash"),
    afterHash: p.text("after_hash"),
    fieldChanges: p.text("field_changes", { mode: "json" }).$type<Record<string, { before: unknown; after: unknown }>>(),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_change").on(t.datasetRunId, t.itemKey, t.changeType),
    p.index("ix_dataset_change_run_cursor").on(t.datasetRunId, t.createdAt, t.uuid),
    p.index("ix_dataset_change_dataset_cursor").on(t.datasetId, t.createdAt, t.uuid),
    p.index("ix_dataset_change_item").on(t.datasetItemId),
]);

export const datasetItemFieldValues = p.sqliteTable("dataset_item_field_values", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.text("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    fieldName: p.text("field_name").notNull(),
    fieldType: p.text("field_type").notNull(),
    stringValue: p.text("string_value"),
    numberValue: p.real("number_value"),
    booleanValue: p.integer("boolean_value", { mode: "boolean" }),
    timestamptzValue: p.integer("timestamptz_value", { mode: "timestamp" }),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: p.integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_item_field").on(t.datasetId, t.itemKey, t.fieldName),
    p.check("dataset_item_field_values_typed_value_chk", sql`
        (${t.fieldType} = 'string'      AND ${t.stringValue}      IS NOT NULL AND ${t.numberValue} IS NULL AND ${t.booleanValue} IS NULL AND ${t.timestamptzValue} IS NULL)
     OR (${t.fieldType} = 'number'      AND ${t.numberValue}      IS NOT NULL AND ${t.stringValue} IS NULL AND ${t.booleanValue} IS NULL AND ${t.timestamptzValue} IS NULL)
     OR (${t.fieldType} = 'boolean'     AND ${t.booleanValue}     IS NOT NULL AND ${t.stringValue} IS NULL AND ${t.numberValue} IS NULL AND ${t.timestamptzValue} IS NULL)
     OR (${t.fieldType} = 'timestamptz' AND ${t.timestamptzValue} IS NOT NULL AND ${t.stringValue} IS NULL AND ${t.numberValue} IS NULL AND ${t.booleanValue} IS NULL)
    `),
    p.index("ix_dsfv_string").on(t.datasetId, t.fieldName, t.stringValue),
    p.index("ix_dsfv_number").on(t.datasetId, t.fieldName, t.numberValue),
    p.index("ix_dsfv_boolean").on(t.datasetId, t.fieldName, t.booleanValue),
    p.index("ix_dsfv_timestamptz").on(t.datasetId, t.fieldName, t.timestamptzValue),
]);

export const runWarnings = p.sqliteTable("run_warnings", {
    uuid: p.text("uuid").primaryKey().$defaultFn(() => randomUUID()),
    templateRunUuid: p.text("template_run_uuid"),                                             // [RESERVED] FK -> template_runs in L3
    datasetRunId: p.text("dataset_run_id").references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    scope: p.text("scope").notNull(),
    code: p.text("code").notNull(),
    message: p.text("message"),
    itemKey: p.text("item_key"),
    url: p.text("url"),
    seedKey: p.text("seed_key"),
    seedIndex: p.integer("seed_index"),
    pageIndex: p.integer("page_index"),
    createdAt: p.integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => [
    p.check("run_warnings_run_ref_chk", sql`${t.templateRunUuid} IS NOT NULL OR ${t.datasetRunId} IS NOT NULL`),
    p.index("ix_run_warnings_dataset_run").on(t.datasetRunId, t.createdAt, t.uuid),
    p.index("ix_run_warnings_template_run").on(t.templateRunUuid, t.createdAt, t.uuid),
    p.index("ix_run_warnings_code").on(t.datasetRunId, t.code),
]);
