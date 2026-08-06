import { getDB, eq, schemas } from "@anycrawl/db";
import type {
    TemplateConfig,
    TemplateClientConfig,
    TemplateExecutionContext,
    TemplateExecutionResult,
    TemplateFilters,
    TemplateListResponse,
    SandboxContext,
} from "@anycrawl/libs";
import { TemplateNotFoundError, TemplateExecutionError } from "../errors/index.js";
import { TemplateCache } from "../cache/index.js";
import { QuickJSSandbox } from "../sandbox/index.js";
import { TemplateCodeValidator } from "../validator/index.js";
import { DomainValidator, type DomainValidationResult } from "../validator/domainValidator.js";

// ---------------------------------------------------------------------------
// L3 orchestrated handler-execution layer: seed + page entrypoints.
// These reuse the same sandbox + validator + trust model as executeTemplate,
// but intentionally SKIP billing/recordExecution (orchestrated runs bill
// per-run, not per handler call).
// ---------------------------------------------------------------------------

/** A single seed emitted by an orchestrated template's seedHandler. */
export interface OrchestratedSeed {
    seedKey: string;
    url: string;
    metadata?: any;
}

export interface RunSeedHandlerParams {
    templateConfig: TemplateConfig;
    variables: Record<string, any>;
}

export interface RunSeedHandlerResult {
    seeds: OrchestratedSeed[];
    warnings?: any[];
}

/** Per-page orchestration context threaded into `run` alongside `requestType`. */
export interface OrchestratedPageContext {
    runId?: string;
    templateRevisionId?: string;
    seedKey?: string;
    pageIndex?: number;
    attempt?: number;
}

export interface RunPageHandlerParams {
    templateConfig: TemplateConfig;
    variables: Record<string, any>;
    requestType: string;
    /** Scrape output for this page; carries HTML so `resolveFullHtml` works with no live page. */
    scrapeResult: {
        url: string;
        rawHtml?: string;
        html?: string;
        markdown?: string;
        [key: string]: any;
    };
    context?: OrchestratedPageContext;
}

export interface RunPageHandlerResult {
    items?: any[];
    nextUrl?: string | null;
    detailRequests?: any[];
    warnings?: any[];
}

/**
 * Template Client - Main class for template management and execution
 */
export class TemplateClient {
    private cache: TemplateCache;
    private sandbox: QuickJSSandbox;
    private validator: TemplateCodeValidator;
    private db: any;
    private dbReady: Promise<void>;

    constructor(config?: TemplateClientConfig) {
        // Resolve cache TTL from env (0 disables cache; >0 sets TTL in ms)
        const ttlFromEnvRaw = process.env.ANYCRAWL_TEMPLATE_CACHE_TTL_MS || process.env.TEMPLATE_CACHE_TTL_MS;
        let effectiveCacheConfig = config?.cacheConfig;
        if (ttlFromEnvRaw !== undefined) {
            const parsedTtl = parseInt(ttlFromEnvRaw, 10);
            if (!Number.isNaN(parsedTtl) && parsedTtl >= 0) {
                effectiveCacheConfig = { ...(effectiveCacheConfig || {}), ttl: parsedTtl } as any;
            }
        }

        this.cache = new TemplateCache(effectiveCacheConfig);
        this.sandbox = new QuickJSSandbox(config?.sandboxConfig);
        this.validator = new TemplateCodeValidator();
        this.dbReady = this.initializeDatabase();
    }

    private async initializeDatabase(): Promise<void> {
        this.db = await getDB();
    }

    /**
     * Get a template by ID
     */
    async getTemplate(templateId: string): Promise<TemplateConfig> {
        await this.dbReady;
        // 1. Check cache first
        let template = await this.cache.get(templateId);
        // 2. Get from database on cache miss (development and production)
        if (!template) {
            const result = await this.db
                .select()
                .from(schemas.templates)
                .where(eq(schemas.templates.templateId, templateId))
                .limit(1);

            if (!result || result.length === 0) {
                throw new TemplateNotFoundError(templateId);
            }
            template = this.mapDbToTemplate(result[0]);
            // 3. Cache the template
            await this.cache.set(templateId, template);
        }

        return template!;
    }

    /**
     * Get templates with filters
     */
    async getTemplates(filters?: TemplateFilters): Promise<TemplateListResponse> {
        await this.dbReady;
        let query = this.db.select().from(schemas.templates);

        // Apply filters
        if (filters?.status) {
            query = query.where(eq(schemas.templates.status, filters.status));
        }

        if (filters?.reviewStatus) {
            query = query.where(eq(schemas.templates.reviewStatus, filters.reviewStatus));
        }

        if (filters?.createdBy) {
            query = query.where(eq(schemas.templates.createdBy, filters.createdBy));
        }

        // Apply pagination
        if (filters?.limit) {
            query = query.limit(filters.limit);
        }

        if (filters?.offset) {
            query = query.offset(filters.offset);
        }

        const results = await query;
        const mappedTemplates = results.map((row: any) => this.mapDbToTemplate(row));

        return {
            templates: mappedTemplates,
            total: results.length,
            limit: filters?.limit || 50,
            offset: filters?.offset || 0,
        };
    }

    /**
     * Execute a template
     */
    async executeTemplate(
        templateId: string,
        context: TemplateExecutionContext
    ): Promise<TemplateExecutionResult> {
        await this.dbReady;
        const startTime = Date.now();

        try {
            // 1. Get template
            const template = await this.getTemplate(templateId);

            // 2. Validate template code if it has custom handlers
            if (template.customHandlers?.requestHandler?.enabled) {
                await this.validator.validateCode(
                    template.customHandlers.requestHandler.code.source,
                    template
                );
            }

            // 4. Execute template
            let result;
            let logs: any[] = [];

            // If custom handler is enabled, execute it and return only template enhancements
            if (template.customHandlers?.requestHandler?.enabled) {
                // Execute custom handler with scrape result context
                const sandboxContext = {
                    template,
                    executionContext: { ...context, scrapeResult: context.scrapeResult || {} },
                    variables: context.variables || {},
                    page: (context as any).page, // Pass page object for browser-based templates
                };

                const customResult = await this.sandbox.executeCode(
                    template.customHandlers.requestHandler.code.source,
                    sandboxContext
                );

                logs = customResult?.logs || [];
                result = customResult || {};
            } else {
                // If no custom handler, return basic template info
                result = {
                    templateId: template.templateId,
                    templateName: template.name,
                    processedBy: 'template_system',
                    processingTime: new Date().toISOString(),
                };
            }

            const executionTime = Date.now() - startTime;

            // 5. Record execution
            await this.recordExecution(template, context, executionTime, true);

            return {
                success: true,
                data: result,
                logs,
                executionTime,
                creditsCharged: template.pricing.perCall,
            };
        } catch (error) {
            const executionTime = Date.now() - startTime;
            const template = await this.getTemplate(templateId).catch(() => null);

            // Record failed execution
            if (template) {
                await this.recordExecution(template, context, executionTime, false, error as Error);
            }

            // Logs are only available when the error originated inside the sandbox
            // (SandboxError carries .logs). Errors from validation or other layers
            // produce an empty array, which is correct since no handler code ran.
            const errorLogs = (error as any)?.logs || [];
            const errorMessage = error instanceof Error ? error.message : String(error);
            const execError = new TemplateExecutionError(
                `Template execution failed: ${errorMessage}`,
                error as Error
            );
            (execError as any).logs = errorLogs;
            throw execError;
        }
    }

    /**
     * L3 orchestrated: execute a template's `seedHandler` to build the initial
     * seed list. Reuses the same sandbox + validator + trust model as
     * {@link executeTemplate}, but SKIPS billing/recordExecution (orchestrated
     * runs bill per-run, not per handler call).
     *
     * @returns the raw author return value (expected `{ seeds, warnings? }`).
     * @throws TemplateExecutionError if the seedHandler is missing or disabled.
     */
    async runSeedHandler(params: RunSeedHandlerParams): Promise<RunSeedHandlerResult> {
        const { templateConfig, variables } = params;

        const seedHandler = templateConfig.customHandlers?.seedHandler;
        if (!seedHandler?.enabled || !seedHandler.code?.source) {
            throw new TemplateExecutionError(
                `Template ${templateConfig.templateId} has no enabled seedHandler`
            );
        }
        const source = seedHandler.code.source;

        // Validate handler code first (same security/trust gate as executeTemplate).
        await this.validator.validateCode(source, templateConfig);

        const sandboxContext: SandboxContext = {
            template: templateConfig,
            executionContext: {
                templateId: templateConfig.templateId,
                variables,
                request: { url: "" },
                scrapeResult: undefined,
                run: { requestType: "seed" },
            } as unknown as TemplateExecutionContext,
            variables,
            page: undefined,
        };

        // executeCode returns { success, result, logs, ... }; author return is at .result.
        const wrapper = await this.sandbox.executeCode(source, sandboxContext);
        return wrapper?.result as RunSeedHandlerResult;
    }

    /**
     * L3 orchestrated: execute a template's page handler (the `requestHandler`,
     * per the design) against an already-fetched scrape result. Reuses the same
     * sandbox + validator + trust model as {@link executeTemplate}, but SKIPS
     * billing/recordExecution (orchestrated runs bill per-run).
     *
     * `scrapeResult` carries `{ url, rawHtml?, html?, markdown? }` so the sandbox's
     * `resolveFullHtml` can supply `html` without a live page object.
     *
     * @returns the raw author return value (expected `{ items?, nextUrl?, detailRequests?, warnings? }`).
     * @throws TemplateExecutionError if the requestHandler is missing or disabled.
     */
    async runPageHandler(params: RunPageHandlerParams): Promise<RunPageHandlerResult> {
        const { templateConfig, variables, requestType, scrapeResult, context } = params;

        const requestHandler = templateConfig.customHandlers?.requestHandler;
        if (!requestHandler?.enabled || !requestHandler.code?.source) {
            throw new TemplateExecutionError(
                `Template ${templateConfig.templateId} has no enabled requestHandler (page handler)`
            );
        }
        const source = requestHandler.code.source;

        // Validate handler code first (same security/trust gate as executeTemplate).
        await this.validator.validateCode(source, templateConfig);

        const sandboxContext: SandboxContext = {
            template: templateConfig,
            executionContext: {
                templateId: templateConfig.templateId,
                variables,
                request: { url: scrapeResult?.url ?? "" },
                scrapeResult,
                run: { requestType, ...(context ?? {}) },
            } as unknown as TemplateExecutionContext,
            variables,
            page: undefined,
        };

        // executeCode returns { success, result, logs, ... }; author return is at .result.
        const wrapper = await this.sandbox.executeCode(source, sandboxContext);
        return wrapper?.result as RunPageHandlerResult;
    }

    /**
     * Validate domain restrictions for a template and URL
     * @param template - The template configuration
     * @param url - The URL to validate
     * @returns DomainValidationResult
     */
    public validateDomainRestrictions(template: TemplateConfig, url: string): DomainValidationResult {
        if (!template.metadata?.allowedDomains) {
            return { isValid: true };
        }

        const domainRestriction = DomainValidator.parseDomainRestriction(template.metadata.allowedDomains);
        if (!domainRestriction) {
            return { isValid: true };
        }

        return DomainValidator.validateDomain(url, domainRestriction);
    }

    /**
     * Record template execution in database
     */
    private async recordExecution(
        template: TemplateConfig,
        context: TemplateExecutionContext,
        executionTime: number,
        success: boolean,
        error?: Error
    ): Promise<void> {
        try {
            await this.db.insert(schemas.templateExecutions).values({
                templateUuid: template.uuid,
                processingTimeMs: executionTime,
                creditsCharged: template.pricing.perCall,
                success,
                errorMessage: error?.message,
                createdAt: new Date(),
            });
        } catch (dbError) {
            // Log error but don't throw - execution recording shouldn't fail the main operation
            console.warn("Failed to record template execution:", dbError);
        }
    }

    /**
     * Map database row to TemplateConfig
     */
    private mapDbToTemplate(row: any): TemplateConfig {
        return {
            uuid: row.uuid,
            templateId: row.templateId,
            name: row.name,
            description: row.description,
            tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || "[]"),
            version: row.version,
            pricing: typeof row.pricing === "object" ? row.pricing : JSON.parse(row.pricing),
            templateType: row.templateType || "scrape",
            reqOptions: typeof row.reqOptions === "object" ? row.reqOptions : JSON.parse(row.reqOptions),
            customHandlers: row.customHandlers ? (typeof row.customHandlers === "object" ? row.customHandlers : JSON.parse(row.customHandlers)) : undefined,
            metadata: typeof row.metadata === "object" ? row.metadata : JSON.parse(row.metadata),
            variables: row.variables ? (typeof row.variables === "object" ? row.variables : JSON.parse(row.variables)) : undefined,
            createdBy: row.createdBy,
            publishedBy: row.publishedBy,
            reviewedBy: row.reviewedBy,
            status: row.status,
            reviewStatus: row.reviewStatus,
            reviewNotes: row.reviewNotes,
            trusted: row.trusted || false,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
            publishedAt: row.publishedAt ? new Date(row.publishedAt) : undefined,
            reviewedAt: row.reviewedAt ? new Date(row.reviewedAt) : undefined,
            archivedAt: row.archivedAt ? new Date(row.archivedAt) : undefined,
        };
    }
}