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
                variables: template.variables ?? {},
                pricing: template.pricing,
                allowed_domains: metadata.allowedDomains ?? null,
            },
        });
    };
}
