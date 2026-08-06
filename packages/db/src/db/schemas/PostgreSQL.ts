import * as p from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export const apiKey = p.pgTable("api_key", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // user uuid
    user: p.uuid("user"),
    // API key value - must be unique
    key: p.text("key").notNull().unique(),
    // Display name for the API key
    name: p.text("name").default("default"),
    // Whether the key is currently active
    isActive: p.boolean("is_active").notNull().default(true),
    // User/system that created this key
    createdBy: p.integer("created_by").default(-1),
    // Available credit balance
    credits: p.integer("credits").notNull().default(0),
    // Timestamp when the key was created
    createdAt: p.timestamp("created_at").notNull(),
    // Timestamp of last API key usage
    lastUsedAt: p.timestamp("last_used_at"),
    // Optional expiration timestamp
    expiresAt: p.timestamp("expires_at"),
    // Allowed IP addresses whitelist (JSON array of IP addresses or CIDR ranges)
    allowedIps: p.jsonb("allowed_ips").$type<string[]>(),
    // Subscription tier for rate limiting (free, paid, etc.)
    subscriptionTier: p.text("subscription_tier").default("free").notNull(),
});

export const requestLog = p.pgTable("request_log", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that made the request
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
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
    requestPayload: p.jsonb("request_payload"),
    // Request header
    requestHeader: p.jsonb("request_header"),
    // Response body
    responseBody: p.jsonb("response_body"),
    // Response header
    responseHeader: p.jsonb("response_header"),
    // Success or not
    success: p.boolean("success").notNull().default(true),
    // create at
    createdAt: p.timestamp("created_at").notNull(),
});

export const billingLedger = p.pgTable("billing_ledger", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Billing ownership
    jobId: p.text("job_id").notNull(),
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // Billing metadata
    mode: p.text("mode").notNull(), // 'delta' | 'target'
    reason: p.text("reason").notNull(),
    idempotencyKey: p.text("idempotency_key").notNull().unique(),
    // Billing amount and usage snapshot
    charged: p.integer("charged").notNull(),
    beforeUsed: p.integer("before_used").notNull(),
    afterUsed: p.integer("after_used").notNull(),
    // Itemized charge details (nullable for historical rows)
    chargeDetails: p.jsonb("charge_details"),
    // Credits snapshot (nullable when unavailable)
    beforeCredits: p.integer("before_credits"),
    afterCredits: p.integer("after_credits"),
    // Timestamp
    createdAt: p.timestamp("created_at").notNull(),
});

export const jobs = p.pgTable("jobs", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job id
    jobId: p.text("job_id").notNull(),
    // job type
    jobType: p.text("job_type").notNull(),
    // job queue name
    jobQueueName: p.text("job_queue_name").notNull(),
    // job expire at
    jobExpireAt: p.timestamp("job_expire_at").notNull().$defaultFn(() => new Date(Date.now() + 3 * 60 * 60 * 1000)),
    // url
    url: p.text("url").notNull(),
    // payload from job
    payload: p.jsonb("payload"),
    // api key
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user or api_key.uuid)
    userId: p.uuid("user_id"),
    // total urls/pages found
    total: p.integer("total").notNull().default(0),
    // completed urls/pages
    completed: p.integer("completed").notNull().default(0),
    // failed urls/pages
    failed: p.integer("failed").notNull().default(0),
    // Number of credits consumed
    creditsUsed: p.integer("credits_used").notNull().default(0),
    // Credit deduction timestamp (null = not yet deducted, set when deduction completes)
    deductedAt: p.timestamp("deducted_at"),
    // Number of cache hits recorded for this job
    cacheHits: p.integer("cache_hits").notNull().default(0),
    // Network traffic usage (application layer bytes)
    trafficBytes: p.bigint("traffic_bytes", { mode: "number" }).notNull().default(0),
    trafficRequestBytes: p.bigint("traffic_request_bytes", { mode: "number" }).notNull().default(0),
    trafficResponseBytes: p.bigint("traffic_response_bytes", { mode: "number" }).notNull().default(0),
    trafficRequestCount: p.integer("traffic_request_count").notNull().default(0),
    // Origin, playground or api
    origin: p.text("origin").notNull(),
    // status of job
    status: p.text("status").notNull(),
    // job success or not
    isSuccess: p.boolean("is_success").notNull().default(false),
    // job error message
    errorMessage: p.text("error_message"),
    // job created at
    createdAt: p.timestamp("created_at").notNull(),
    // job updated at
    updatedAt: p.timestamp("updated_at").notNull(),
});

export const jobResults = p.pgTable("job_results", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // job uuid
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    // url
    url: p.text("url").notNull(),
    // data
    data: p.jsonb("data"),
    // status
    status: p.text("status").notNull(),
    // created at
    createdAt: p.timestamp("created_at").notNull(),
    // updated at
    updatedAt: p.timestamp("updated_at").notNull(),
});

// Template system tables
export const templates = p.pgTable("templates", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
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
    tags: p.jsonb("tags").notNull(),
    // Template version
    version: p.text("version").notNull().default("1.0.0"),
    // Template type - determines which operation this template supports
    templateType: p.text("template_type").notNull().default("scrape"),
    // Pricing information (JSON): { perCall: number, currency: "credits" }
    pricing: p.jsonb("pricing").notNull(),
    // Request options configuration (JSON) - supports scrape, crawl, and search
    reqOptions: p.jsonb("req_options").notNull(),
    // Custom handlers code (JSON)
    customHandlers: p.jsonb("custom_handlers"),
    // Template metadata (JSON)
    metadata: p.jsonb("metadata").notNull(),
    // Template variables (JSON): { [key: string]: { type: string, description: string, required: boolean, defaultValue?: any } }
    variables: p.jsonb("variables"),
    // User information
    createdBy: p.text("created_by").notNull(),
    publishedBy: p.text("published_by"),
    reviewedBy: p.text("reviewed_by"),
    // Status fields
    status: p.text("status").default("draft").notNull(),
    reviewStatus: p.text("review_status").default("pending").notNull(),
    reviewNotes: p.text("review_notes"),
    // Trusted flag - if true, can use AsyncFunction with page object; if false, must use VM sandbox
    trusted: p.boolean("trusted").notNull().default(false),
    // Timestamps
    createdAt: p.timestamp("created_at").notNull(),
    updatedAt: p.timestamp("updated_at").notNull(),
    publishedAt: p.timestamp("published_at"),
    reviewedAt: p.timestamp("reviewed_at"),
    archivedAt: p.timestamp("archived_at"),
    // [L3] Pointer to the current immutable template_revisions snapshot (§9.1 rule 7).
    // Deliberately a plain nullable uuid with NO .references(): template_revisions FKs
    // back to templates.uuid, so a real FK here would create a circular dependency and
    // an unsatisfiable insert ordering. The pointer is maintained in application code.
    currentRevisionUuid: p.uuid("current_revision_uuid"),
});

export const templateExecutions = p.pgTable("template_executions", {
    // Primary key with auto-incrementing ID
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Foreign key to templates
    templateUuid: p.uuid("template_uuid").notNull().references(() => templates.uuid),
    // API key that made the request
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    // Job information
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    // Request processing time in milliseconds
    processingTimeMs: p.real("processing_time_ms").notNull(),
    // Number of credits consumed
    creditsCharged: p.integer("credits_charged").default(0).notNull(),
    // Success or not
    success: p.boolean("success").notNull(),
    // Error message if failed
    errorMessage: p.text("error_message"),
    // Timestamp
    createdAt: p.timestamp("created_at").notNull(),
});

// Scheduled Tasks and Webhooks tables
export const scheduledTasks = p.pgTable("scheduled_tasks", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this task
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    taskType: p.text("task_type").notNull(),
    taskPayload: p.jsonb("task_payload").notNull(),
    cronExpression: p.text("cron_expression").notNull(),
    timezone: p.text("timezone").default("UTC").notNull(),
    concurrencyMode: p.text("concurrency_mode").default("skip").notNull(),
    maxExecutionsPerDay: p.integer("max_executions_per_day"),
    minCreditsRequired: p.integer("min_credits_required").default(1).notNull(),
    isActive: p.boolean("is_active").default(true).notNull(),
    isPaused: p.boolean("is_paused").default(false).notNull(),
    pauseReason: p.text("pause_reason"),
    lastExecutionAt: p.timestamp("last_execution_at", { withTimezone: true }),
    nextExecutionAt: p.timestamp("next_execution_at", { withTimezone: true }),
    totalExecutions: p.integer("total_executions").default(0).notNull(),
    successfulExecutions: p.integer("successful_executions").default(0).notNull(),
    failedExecutions: p.integer("failed_executions").default(0).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    tags: p.jsonb("tags"),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const taskExecutions = p.pgTable("task_executions", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    scheduledTaskUuid: p.uuid("scheduled_task_uuid").notNull().references(() => scheduledTasks.uuid, { onDelete: "cascade" }),
    executionNumber: p.integer("execution_number").notNull(),
    idempotencyKey: p.text("idempotency_key").notNull().unique(),
    status: p.text("status").default("pending").notNull(),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    completedAt: p.timestamp("completed_at", { withTimezone: true }),
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    // Note: creditsUsed, itemsProcessed, itemsSucceeded, itemsFailed, durationMs
    // are retrieved from jobs table via JOIN - removed to avoid data duplication
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    errorDetails: p.jsonb("error_details"),
    triggeredBy: p.text("triggered_by").default("scheduler").notNull(),
    scheduledFor: p.timestamp("scheduled_for", { withTimezone: true }).notNull(),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const webhookSubscriptions = p.pgTable("webhook_subscriptions", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // API key that created this webhook
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    // User ID (from api_key.user, can be null)
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    webhookUrl: p.text("webhook_url").notNull(),
    webhookSecret: p.text("webhook_secret").notNull(),
    scope: p.text("scope").default("all").notNull(),
    specificTaskIds: p.jsonb("specific_task_ids"),
    eventTypes: p.jsonb("event_types").notNull(),
    customHeaders: p.jsonb("custom_headers"),
    timeoutSeconds: p.integer("timeout_seconds").default(10).notNull(),
    maxRetries: p.integer("max_retries").default(3).notNull(),
    retryBackoffMultiplier: p.real("retry_backoff_multiplier").default(2).notNull(),
    isActive: p.boolean("is_active").default(true).notNull(),
    consecutiveFailures: p.integer("consecutive_failures").default(0).notNull(),
    autoDisableAfterFailures: p.integer("auto_disable_after_failures").default(10).notNull(),
    lastSuccessAt: p.timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: p.timestamp("last_failure_at", { withTimezone: true }),
    totalDeliveries: p.integer("total_deliveries").default(0).notNull(),
    successfulDeliveries: p.integer("successful_deliveries").default(0).notNull(),
    failedDeliveries: p.integer("failed_deliveries").default(0).notNull(),
    tags: p.jsonb("tags"),
    metadata: p.jsonb("metadata"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const webhookDeliveries = p.pgTable("webhook_deliveries", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    webhookSubscriptionUuid: p.uuid("webhook_subscription_uuid").notNull().references(() => webhookSubscriptions.uuid, { onDelete: "cascade" }),
    eventType: p.text("event_type").notNull(),
    eventSource: p.text("event_source").notNull(),
    eventSourceId: p.uuid("event_source_id").notNull(),
    status: p.text("status").default("pending").notNull(),
    attemptNumber: p.integer("attempt_number").default(1).notNull(),
    maxAttempts: p.integer("max_attempts").default(3).notNull(),
    requestUrl: p.text("request_url").notNull(),
    requestMethod: p.text("request_method").default("POST").notNull(),
    requestHeaders: p.jsonb("request_headers"),
    requestBody: p.jsonb("request_body"),
    responseStatus: p.integer("response_status"),
    responseHeaders: p.jsonb("response_headers"),
    responseBody: p.text("response_body"),
    responseDurationMs: p.integer("response_duration_ms"),
    errorMessage: p.text("error_message"),
    errorCode: p.text("error_code"),
    nextRetryAt: p.timestamp("next_retry_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    deliveredAt: p.timestamp("delivered_at", { withTimezone: true }),
});

// Cache tables for storing scraped page data
export const pageCache = p.pgTable("page_cache", {
    uuid: p
        .uuid()
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
    isMobile: p.boolean("is_mobile").default(false),
    hasProxy: p.boolean("has_proxy").default(false),
    hasScreenshot: p.boolean("has_screenshot").default(false),
    // Timestamps
    scrapedAt: p.timestamp("scraped_at", { withTimezone: true }).notNull(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
    p.uniqueIndex("page_cache_url_options_idx").on(table.urlHash, table.optionsHash),
    p.index("page_cache_url_hash_idx").on(table.urlHash),
    p.index("page_cache_domain_idx").on(table.domain),
    p.index("page_cache_scraped_at_idx").on(table.scrapedAt),
]);

export const mapCache = p.pgTable("map_cache", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Domain information
    domain: p.text("domain").notNull(),
    domainHash: p.text("domain_hash").notNull(),
    // Discovered URLs
    urls: p.jsonb("urls").notNull().$type<Array<{ url: string; title?: string; description?: string }>>(),
    urlCount: p.integer("url_count").notNull(),
    // Source of discovery
    source: p.text("source").notNull(), // 'sitemap' | 'search' | 'crawl'
    // Timestamps
    discoveredAt: p.timestamp("discovered_at", { withTimezone: true }).notNull(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
    p.uniqueIndex("map_cache_domain_source_idx").on(table.domainHash, table.source),
    p.index("map_cache_domain_hash_idx").on(table.domainHash),
    p.index("map_cache_discovered_at_idx").on(table.discoveredAt),
]);

// Monitor tables — web change / price monitoring built on top of scheduled_tasks
export const monitors = p.pgTable("monitors", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    // Owner
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    // 'webpage' | 'price'
    monitorType: p.text("monitor_type").default("webpage").notNull(),
    // Underlying scheduled task that drives the recurring scrape (1:1)
    scheduledTaskUuid: p.uuid("scheduled_task_uuid").references(() => scheduledTasks.uuid, { onDelete: "cascade" }),
    // [{ url, engine, options, location? }]
    targets: p.jsonb("targets").notNull(),
    // Natural-language judge criterion (optional)
    goal: p.text("goal"),
    // 'text' | 'json' | 'mixed'
    trackMode: p.text("track_mode").default("text").notNull(),
    // JSON schema used for structured (price) extraction
    extractSchema: p.jsonb("extract_schema"),
    // { ignoreSelectors?, onlyMainContent?, minChangeRatio? }
    diffOptions: p.jsonb("diff_options"),
    // { channels, emailRecipients?, onlyMeaningful?, thresholds? }
    notifyOptions: p.jsonb("notify_options"),
    isActive: p.boolean("is_active").default(true).notNull(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
    p.index("monitors_api_key_idx").on(table.apiKey),
    p.index("monitors_user_id_idx").on(table.userId),
    p.index("monitors_scheduled_task_idx").on(table.scheduledTaskUuid),
]);

export const monitorSnapshots = p.pgTable("monitor_snapshots", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    monitorUuid: p.uuid("monitor_uuid").notNull().references(() => monitors.uuid, { onDelete: "cascade" }),
    taskExecutionUuid: p.uuid("task_execution_uuid").references(() => taskExecutions.uuid),
    url: p.text("url").notNull(),
    // sha256 of normalized content
    contentHash: p.text("content_hash").notNull(),
    // Inlined normalized content (truncated); large content moves to S3 later
    content: p.text("content"),
    // Structured extraction result (price mode)
    extracted: p.jsonb("extracted"),
    // 'new' | 'same' | 'changed' | 'removed' | 'error'
    status: p.text("status").notNull(),
    capturedAt: p.timestamp("captured_at", { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
    p.index("monitor_snapshots_monitor_url_idx").on(table.monitorUuid, table.url, table.capturedAt),
]);

export const monitorChanges = p.pgTable("monitor_changes", {
    uuid: p
        .uuid()
        .primaryKey()
        .$defaultFn(() => randomUUID()),
    monitorUuid: p.uuid("monitor_uuid").notNull().references(() => monitors.uuid, { onDelete: "cascade" }),
    url: p.text("url").notNull(),
    fromSnapshotUuid: p.uuid("from_snapshot_uuid"),
    toSnapshotUuid: p.uuid("to_snapshot_uuid"),
    // 'content' | 'price_up' | 'price_down' | 'stock' | 'new' | 'removed'
    changeType: p.text("change_type").notNull(),
    diffText: p.text("diff_text"),
    // [{ path, from, to, delta? }]
    diffJson: p.jsonb("diff_json"),
    // { meaningful, confidence, reason }
    judgment: p.jsonb("judgment"),
    notified: p.boolean("notified").default(false).notNull(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
    p.index("monitor_changes_monitor_idx").on(table.monitorUuid, table.createdAt),
]);

// ============================================================================
// Dataset (L2) tables — platform §11 / dedicated §5.9.
// MVP tables: datasets, dataset_runs, dataset_items, dataset_item_changes.
// FULL-only tables: dataset_run_items, dataset_item_scopes, dataset_item_field_values, run_warnings.
// MVP -> full is pure add-table/add-column/add-constraint (R2 forward-compat, no renames).
// ============================================================================

export const datasets = p.pgTable("datasets", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    userId: p.uuid("user_id"),
    name: p.text("name").notNull(),
    description: p.text("description"),
    sourceType: p.text("source_type").notNull(),
    sourceTemplateId: p.text("source_template_id"),
    sourceTemplateRevisionUuid: p.uuid("source_template_revision_uuid"),          // [RESERVED per R2] FK -> template_revisions in L3
    schemaName: p.text("schema_name").notNull(),
    schemaVersion: p.text("schema_version").notNull(),
    retentionPolicy: p.jsonb("retention_policy").$type<{ item_days?: number; change_days?: number }>(),
    itemCount: p.integer("item_count").notNull().default(0),
    activeItemCount: p.integer("active_item_count").notNull().default(0),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: p.timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
    p.index("ix_datasets_user_created").on(t.userId, t.createdAt, t.uuid).where(sql`${t.deletedAt} IS NULL`),
    p.index("ix_datasets_apikey_created").on(t.apiKey, t.createdAt, t.uuid).where(sql`${t.deletedAt} IS NULL`),
]);

export const datasetRuns = p.pgTable("dataset_runs", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.uuid("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    producerType: p.text("producer_type").notNull(),
    producerId: p.text("producer_id").notNull(),
    jobUuid: p.uuid("job_uuid").references(() => jobs.uuid),
    scheduledTaskUuid: p.uuid("scheduled_task_uuid").references(() => scheduledTasks.uuid),   // [RESERVED per R2]
    templateRunUuid: p.uuid("template_run_uuid"),                                             // [RESERVED per R2] FK -> template_runs in L3
    scopeKey: p.text("scope_key").notNull(),
    status: p.text("status").notNull(),
    coverageComplete: p.boolean("coverage_complete").notNull().default(false),
    itemsSeen: p.integer("items_seen").notNull().default(0),
    itemsCreated: p.integer("items_created").notNull().default(0),
    itemsUpdated: p.integer("items_updated").notNull().default(0),
    itemsUnchanged: p.integer("items_unchanged").notNull().default(0),
    itemsRemoved: p.integer("items_removed").notNull().default(0),
    warningCount: p.integer("warning_count").notNull().default(0),
    warningSummary: p.jsonb("warning_summary").$type<Array<{ code: string; count: number }>>(),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    finishedAt: p.timestamp("finished_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_run_producer").on(t.datasetId, t.producerType, t.producerId),
    p.index("ix_dataset_run_job").on(t.jobUuid),
    p.index("ix_dataset_run_scheduled_task").on(t.scheduledTaskUuid),
    p.index("ix_dataset_run_template_run").on(t.templateRunUuid),
    p.index("ix_dataset_run_scope").on(t.datasetId, t.scopeKey, t.status),
]);

export const datasetItems = p.pgTable("dataset_items", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.uuid("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    sourceType: p.text("source_type").notNull(),
    sourceUrl: p.text("source_url"),
    document: p.jsonb("document").notNull().$type<Record<string, unknown>>(),
    documentHash: p.text("document_hash").notNull(),
    firstSeenAt: p.timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: p.timestamp("last_seen_at", { withTimezone: true }).notNull(),
    isActive: p.boolean("is_active").notNull().default(true),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_item").on(t.datasetId, t.itemKey),
    p.index("ix_dataset_item_cursor").on(t.datasetId, t.lastSeenAt, t.uuid),
]);

export const datasetRunItems = p.pgTable("dataset_run_items", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetRunId: p.uuid("dataset_run_id").notNull().references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    datasetItemId: p.uuid("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    sequence: p.integer("sequence"),
    seedKey: p.text("seed_key"),
    seedIndex: p.integer("seed_index"),
    pageIndex: p.integer("page_index"),
    position: p.integer("position"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_run_item").on(t.datasetRunId, t.itemKey),
    p.uniqueIndex("uq_dataset_run_item_sequence").on(t.datasetRunId, t.sequence).where(sql`${t.sequence} IS NOT NULL`),
    p.index("ix_dataset_run_item_seq").on(t.datasetRunId, t.sequence),
    p.index("ix_dataset_run_item_occurrence").on(t.datasetRunId, t.seedIndex, t.pageIndex, t.position),
    p.index("ix_dataset_run_item_item").on(t.datasetItemId),
]);

export const datasetItemScopes = p.pgTable("dataset_item_scopes", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.uuid("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    datasetItemId: p.uuid("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    scopeKey: p.text("scope_key").notNull(),
    firstSeenAt: p.timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: p.timestamp("last_seen_at", { withTimezone: true }).notNull(),
    isActive: p.boolean("is_active").notNull().default(true),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_item_scope").on(t.datasetId, t.itemKey, t.scopeKey),
    p.index("ix_dataset_item_scope_recon").on(t.datasetId, t.scopeKey, t.isActive),
    p.index("ix_dataset_item_scope_item").on(t.datasetItemId),
]);

export const datasetItemChanges = p.pgTable("dataset_item_changes", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.uuid("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    datasetRunId: p.uuid("dataset_run_id").notNull().references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    datasetItemId: p.uuid("dataset_item_id").notNull().references(() => datasetItems.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    scopeKey: p.text("scope_key").notNull(),
    changeType: p.text("change_type").notNull(),
    beforeHash: p.text("before_hash"),
    afterHash: p.text("after_hash"),
    fieldChanges: p.jsonb("field_changes").$type<Record<string, { before: unknown; after: unknown }>>(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_dataset_change").on(t.datasetRunId, t.itemKey, t.changeType),
    p.index("ix_dataset_change_run_cursor").on(t.datasetRunId, t.createdAt, t.uuid),
    p.index("ix_dataset_change_dataset_cursor").on(t.datasetId, t.createdAt, t.uuid),
    p.index("ix_dataset_change_item").on(t.datasetItemId),
]);

export const datasetItemFieldValues = p.pgTable("dataset_item_field_values", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    datasetId: p.uuid("dataset_id").notNull().references(() => datasets.uuid, { onDelete: "cascade" }),
    itemKey: p.text("item_key").notNull(),
    fieldName: p.text("field_name").notNull(),
    fieldType: p.text("field_type").notNull(),
    stringValue: p.text("string_value"),
    numberValue: p.numeric("number_value"),
    booleanValue: p.boolean("boolean_value"),
    timestamptzValue: p.timestamp("timestamptz_value", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
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

export const runWarnings = p.pgTable("run_warnings", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    templateRunUuid: p.uuid("template_run_uuid"),                                             // [RESERVED] FK -> template_runs in L3
    datasetRunId: p.uuid("dataset_run_id").references(() => datasetRuns.uuid, { onDelete: "cascade" }),
    scope: p.text("scope").notNull(),
    code: p.text("code").notNull(),
    message: p.text("message"),
    itemKey: p.text("item_key"),
    url: p.text("url"),
    seedKey: p.text("seed_key"),
    seedIndex: p.integer("seed_index"),
    pageIndex: p.integer("page_index"),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.check("run_warnings_run_ref_chk", sql`${t.templateRunUuid} IS NOT NULL OR ${t.datasetRunId} IS NOT NULL`),
    p.index("ix_run_warnings_dataset_run").on(t.datasetRunId, t.createdAt, t.uuid),
    p.index("ix_run_warnings_template_run").on(t.templateRunUuid, t.createdAt, t.uuid),
    p.index("ix_run_warnings_code").on(t.datasetRunId, t.code),
]);

// ============================================================================
// Template Revisions (L3) — immutable template version snapshots (platform §9.1).
// A revision freezes the full execution config + output schema for a template so
// historical Runs/Schedules stay reproducible and are unaffected by later edits.
// UNIQUE(template_uuid, config_hash) makes concurrent get-or-create idempotent
// (§9.1 rule 6). templates.current_revision_uuid points at the active revision.
// ============================================================================

export const templateRevisions = p.pgTable("template_revisions", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    templateUuid: p.uuid("template_uuid").notNull().references(() => templates.uuid, { onDelete: "cascade" }),
    version: p.text("version").notNull(),
    configHash: p.text("config_hash").notNull(),
    configSnapshot: p.jsonb("config_snapshot").notNull().$type<Record<string, unknown>>(),
    schemaSnapshot: p.jsonb("schema_snapshot").$type<Record<string, unknown>>(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.uniqueIndex("uq_template_revision").on(t.templateUuid, t.configHash),
    p.index("ix_template_revision_created").on(t.templateUuid, t.createdAt, t.uuid),
]);

// ============================================================================
// Template Runs (L3 Phase 3) — the unified async run record for every Template
// execution, legacy or orchestrated (platform §9.2). One row carries owner,
// the frozen revision + input snapshot, the dataset destination, and the full
// lifecycle: status advances queued→running→{completed|partial|failed} and
// cancelling→cancelled (§5); terminal states are immutable. `template_run_events`
// is the append-only audit feed backing `/events` cursor polling (§11.8).
//
// FK notes: `template_uuid` cascades like `template_revisions` (a run is history
// owned by its template). Association FKs (revision/dataset/dataset_run/legacy
// job) are plain nullable references. The reserved `dataset_runs.template_run_uuid`
// and `run_warnings.template_run_uuid` columns stay FK-less to avoid the circular
// dependency (they are declared above this table).
//
// Idempotency: `idempotency_scope_hash` is derived from Owner + Template +
// original Idempotency-Key (§9.2 rule 2), so owner is already baked into the
// value. A single partial unique index over (template_uuid, idempotency_scope_hash)
// WHERE hash IS NOT NULL therefore makes create idempotent without persisting a
// cross-owner plaintext tuple and without needing two owner-keyed indexes.
// ============================================================================

export const templateRuns = p.pgTable("template_runs", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    apiKey: p.uuid("api_key_id").references(() => apiKey.uuid),
    userId: p.uuid("user_id"),
    templateUuid: p.uuid("template_uuid").notNull().references(() => templates.uuid, { onDelete: "cascade" }),
    templateRevisionUuid: p.uuid("template_revision_uuid").references(() => templateRevisions.uuid),  // nullable: legacy adapter may run current config
    mode: p.text("mode").notNull(),                                                                    // single | orchestrated
    status: p.text("status").notNull(),                                                                // queued | running | partial | completed | failed | cancelling | cancelled
    idempotencyScopeHash: p.text("idempotency_scope_hash"),
    inputSnapshot: p.jsonb("input_snapshot").$type<Record<string, unknown>>(),
    normalizedInputHash: p.text("normalized_input_hash"),
    runOptions: p.jsonb("run_options").$type<Record<string, unknown>>(),
    datasetId: p.uuid("dataset_id").references(() => datasets.uuid),
    datasetRunUuid: p.uuid("dataset_run_uuid").references(() => datasetRuns.uuid),
    legacyJobUuid: p.uuid("legacy_job_uuid").references(() => jobs.uuid),
    statistics: p.jsonb("statistics").$type<Record<string, unknown>>(),
    stopReason: p.text("stop_reason"),
    errorCode: p.text("error_code"),
    errorMessage: p.text("error_message"),
    cancelRequestedAt: p.timestamp("cancel_requested_at", { withTimezone: true }),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    finishedAt: p.timestamp("finished_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.index("ix_template_run_user_created").on(t.userId, t.createdAt, t.uuid),
    p.index("ix_template_run_apikey_created").on(t.apiKey, t.createdAt, t.uuid),
    p.index("ix_template_run_template_created").on(t.templateUuid, t.createdAt, t.uuid),
    p.uniqueIndex("uq_template_run_idempotency")
        .on(t.templateUuid, t.idempotencyScopeHash)
        .where(sql`${t.idempotencyScopeHash} IS NOT NULL`),
    // Explicit FK indexes (§11.9 rule 1); owner/template FKs are covered by the composite lists above.
    p.index("ix_template_run_revision").on(t.templateRevisionUuid),
    p.index("ix_template_run_dataset").on(t.datasetId),
    p.index("ix_template_run_dataset_run").on(t.datasetRunUuid),
    p.index("ix_template_run_legacy_job").on(t.legacyJobUuid),
]);

export const templateRunEvents = p.pgTable("template_run_events", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    templateRunUuid: p.uuid("template_run_id").notNull().references(() => templateRuns.uuid, { onDelete: "cascade" }),
    eventType: p.text("event_type").notNull(),
    payload: p.jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    p.index("ix_template_run_event_cursor").on(t.templateRunUuid, t.createdAt, t.uuid),
]);

// ============================================================================
// Template Run Requests (L3 Phase 4) — orchestrated request ledger (platform
// §9.3). One row per logical request an orchestrated Run dispatches (seed / page
// / detail). The DB holds business state (visited/loop-detection + resume);
// BullMQ holds dispatch state; the two align through the stable `queue_job_id`.
// `UNIQUE(template_run_id, request_key)` makes enqueue idempotent so a BullMQ
// retry never re-dispatches the same logical request. `request_key` is derived
// from request type + seed + normalized URL, and the page/detail visited check
// reads this ledger.
//
// `parent_request_id` is a PLAIN column, NOT a self-referencing FK: a child
// request (e.g. a detail spawned by a page) can be enqueued before/independently
// of a strict parent-insert ordering, and orchestrated resume may re-materialize
// rows out of order — a self-FK would impose an insert-ordering constraint and
// risk violations on replay. Referential integrity of the parent link is
// enforced in the model/worker layer, not by the schema.
// ============================================================================

export const templateRunRequests = p.pgTable("template_run_requests", {
    uuid: p.uuid().primaryKey().$defaultFn(() => randomUUID()),
    templateRunUuid: p.uuid("template_run_id").notNull().references(() => templateRuns.uuid, { onDelete: "cascade" }),
    requestKey: p.text("request_key").notNull(),                        // derived: request type + seed + normalized URL
    requestType: p.text("request_type").notNull(),                     // page | detail | seed
    seedKey: p.text("seed_key"),
    seedIndex: p.integer("seed_index"),
    parentRequestUuid: p.uuid("parent_request_id"),                    // plain column, NO self-FK (see note above)
    normalizedUrl: p.text("normalized_url").notNull(),
    pageIndex: p.integer("page_index"),
    status: p.text("status").notNull(),                                // queued | running | completed | failed | skipped
    attempts: p.integer("attempts").notNull().default(0),
    queueJobId: p.text("queue_job_id"),
    lastError: p.text("last_error"),
    queuedAt: p.timestamp("queued_at", { withTimezone: true }),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    finishedAt: p.timestamp("finished_at", { withTimezone: true }),
    createdAt: p.timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [
    // Idempotent dispatch guard (§9.3): one row per logical request within a run.
    p.uniqueIndex("uq_template_run_request").on(t.templateRunUuid, t.requestKey),
    // Status scans within a run (claimNext / countByStatus).
    p.index("ix_template_run_request_status").on(t.templateRunUuid, t.status),
    // Deterministic ordering / visited walk within a run.
    p.index("ix_template_run_request_seq").on(t.templateRunUuid, t.seedIndex, t.pageIndex),
]);
