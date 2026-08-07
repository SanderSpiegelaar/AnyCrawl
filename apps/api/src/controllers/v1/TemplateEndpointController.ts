import { Response } from "express";
import { RequestWithAuth } from "@anycrawl/libs";
import { log } from "@anycrawl/libs";
import { resolveTemplateByRef } from "@anycrawl/db";
import { TemplateHandler } from "../../utils/templateHandler.js";
import { ScrapeController } from "./ScrapeController.js";
import { SearchController } from "./SearchController.js";
import { CrawlController } from "./CrawlController.js";

/**
 * Dispatcher for per-template dedicated endpoints.
 *
 * Gives every template its own URL without registering a route per template:
 *   POST /v1/template/{templateRef}/execute   -> single synchronous execution
 *   GET  /v1/template/{templateRef}            -> call-spec (discovery)
 *
 * {templateRef} is a vanity slug (preferred) or the templateId (Apify: actorId ~ username~actor-name).
 *
 * The dispatcher does three things, then delegates to the existing controller — zero logic
 * duplication. Option merging, variable validation, domain restrictions, URL/query transforms,
 * pricing.perCall billing, caching and webhooks all stay in the delegated controller and behave
 * identically to a body `template_id` call.
 */
export class TemplateEndpointController {
    private readonly scrapeController = new ScrapeController();
    private readonly searchController = new SearchController();
    private readonly crawlController = new CrawlController();

    private currentUserId(req: RequestWithAuth): string | undefined {
        return req.auth?.user ? String(req.auth.user) : undefined;
    }

    private notFound(res: Response, ref: string): void {
        res.status(404).json({
            success: false,
            error: "Not found",
            message: `Template not found: ${ref}`,
            data: { type: "TEMPLATE_NOT_FOUND" },
        });
    }

    private forbidden(res: Response): void {
        res.status(403).json({
            success: false,
            error: "Access denied",
            message: "You don't have permission to use this template",
            data: { type: "ACCESS_DENIED" },
        });
    }

    /**
     * POST /v1/template/{templateRef}/execute
     */
    public execute = async (req: RequestWithAuth, res: Response): Promise<void> => {
        const ref = req.params.templateRef ?? "";
        if (!ref) {
            this.notFound(res, ref);
            return;
        }
        const template = await resolveTemplateByRef(ref);
        if (!template) {
            this.notFound(res, ref);
            return;
        }

        if (!TemplateHandler.hasTemplateAccess(template, this.currentUserId(req))) {
            this.forbidden(res);
            return;
        }

        // The resolved templateId is the single source of truth. A body template_id that
        // disagrees with the path is a client error.
        const bodyTemplateId = (req.body as any)?.template_id;
        if (bodyTemplateId && bodyTemplateId !== template.templateId) {
            res.status(400).json({
                success: false,
                error: "Validation error",
                message: `Body template_id '${bodyTemplateId}' conflicts with path '${ref}'`,
                data: { type: "VALIDATION_ERROR" },
            });
            return;
        }

        req.body = { ...(req.body as any), template_id: template.templateId };

        // Let the deduction middleware know the real action (delta for crawl, target otherwise)
        // without sniffing req.path (which is the parametric /v1/template/:ref/execute here).
        req.resolvedTemplateType = template.templateType;

        log.info(`[TEMPLATE] execute ref=${ref} -> template_id=${template.templateId} type=${template.templateType}`);

        switch (template.templateType) {
            case "scrape":
                await this.scrapeController.handle(req, res);
                return;
            case "search":
                await this.searchController.handle(req, res);
                return;
            case "crawl":
                await this.crawlController.start(req, res);
                return;
            default:
                res.status(400).json({
                    success: false,
                    error: "Validation error",
                    message: `Unsupported template type: ${template.templateType}`,
                    data: { type: "VALIDATION_ERROR" },
                });
                return;
        }
    };

    /**
     * GET /v1/template/{templateRef}
     * Returns a redacted "call-spec" so callers / marketplace / Dashboard can self-describe the
     * template's inputs, pricing and endpoint. Never exposes reqOptions / handlers.
     */
    public spec = async (req: RequestWithAuth, res: Response): Promise<void> => {
        const ref = req.params.templateRef ?? "";
        if (!ref) {
            this.notFound(res, ref);
            return;
        }
        const template = await resolveTemplateByRef(ref);
        if (!template) {
            this.notFound(res, ref);
            return;
        }

        if (!TemplateHandler.hasTemplateAccess(template, this.currentUserId(req))) {
            this.forbidden(res);
            return;
        }

        // Prefer the slug for the branded short link; fall back to templateId.
        const pathRef = template.slug || template.templateId;
        const metadata = (template.metadata as any) || {};

        // --- inputs.url_mode (design doc §5.6) ---------------------------------
        // Precedence: explicit template declaration > orchestrated-with-seedBuilder
        // inference > today's universal default ("user" supplies url/query).
        const VALID_URL_MODES = ["user", "fixed", "generated", "hybrid"] as const;
        type UrlMode = (typeof VALID_URL_MODES)[number];
        let urlMode: UrlMode;
        if (VALID_URL_MODES.includes(metadata.urlMode)) {
            urlMode = metadata.urlMode;
        } else if (template.runtime?.mode === "orchestrated" && template.runtime?.seedBuilder) {
            urlMode = "generated";
        } else {
            urlMode = "user";
        }

        const primaryKey = template.templateType === "search" ? "query" : "url";
        const required: string[] = [];
        const optional: string[] = [];
        if (urlMode === "user") {
            required.push(primaryKey);
        } else if (urlMode === "hybrid") {
            optional.push(primaryKey);
        }
        // "fixed" / "generated": primaryKey appears in neither list.

        const variableEntries = Object.values(template.variables ?? {});
        if (variableEntries.length > 0) {
            if (variableEntries.some((v: any) => v?.required === true)) {
                required.push("variables");
            } else {
                optional.push("variables");
            }
        }

        res.status(200).json({
            success: true,
            data: {
                template_id: template.templateId,
                slug: template.slug ?? null,
                name: template.name,
                description: template.description,
                template_type: template.templateType,
                version: template.version,
                endpoint: {
                    method: "POST",
                    path: `/v1/template/${pathRef}/execute`,
                },
                inputs: { required, optional, url_mode: urlMode },
                variables: template.variables ?? {},
                pricing: template.pricing,
                allowed_domains: metadata.allowedDomains ?? null,
                // L3: lets a client pick sync (/execute) vs async orchestrated (/runs)
                // and know whether results can be written to a Dataset.
                runtime: { mode: template.runtime?.mode ?? "single" },
                output: {
                    dataset_supported: true,
                    return_modes: ["result", "items"],
                    schema: template.outputSchema
                        ? { name: template.outputSchema.name, version: template.outputSchema.version }
                        : null,
                },
            },
        });
    };
}
