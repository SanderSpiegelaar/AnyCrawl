import { getDB, schemas } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
import type { TemplateConfig } from "@anycrawl/libs";
import {
    validateSlug,
    isSlugUniqueViolation,
    SlugValidationError,
    type SlugValidationDeps,
} from "./slug.js";

export interface CreateTemplateParams {
    templateId: string;
    slug?: string | null;
    name: string;
    description?: string;
    tags: string[];
    templateType: "scrape" | "crawl" | "search";
    pricing: {
        perCall: number;
        currency: string;
    };
    reqOptions: any;
    customHandlers?: any;
    metadata?: any;
    variables?: any;
    createdBy: string;
    publishedBy?: string;
    reviewedBy?: string;
    status?: string;
    reviewStatus?: string;
    reviewNotes?: string;
    trusted?: boolean;
}

export class Template {
    /**
     * Create a new template
     */
    static async create(params: CreateTemplateParams): Promise<TemplateConfig> {
        const db = await getDB();

        // Validate slug at the model choke point so every write path is covered.
        // Only runs when a slug is actually provided (nullable slug stays valid).
        if (params.slug != null) {
            await validateSlug(params.slug, {
                selfTemplateId: params.templateId,
                deps: Template.slugValidationDeps(),
            });
        }

        const templateData = {
            templateId: params.templateId,
            slug: params.slug ?? null,
            name: params.name,
            description: params.description || "",
            tags: params.tags,
            version: "1.0.0",
            templateType: params.templateType,
            pricing: params.pricing,
            reqOptions: params.reqOptions,
            customHandlers: params.customHandlers || null,
            metadata: params.metadata || {},
            variables: params.variables || null,
            createdBy: params.createdBy,
            publishedBy: params.publishedBy || null,
            reviewedBy: params.reviewedBy || null,
            status: params.status || "draft",
            reviewStatus: params.reviewStatus || "pending",
            reviewNotes: params.reviewNotes || "",
            trusted: params.trusted || false,
            createdAt: new Date(),
            updatedAt: new Date(),
            publishedAt: params.publishedBy ? new Date() : null,
            reviewedAt: params.reviewedBy ? new Date() : null,
        };

        let result;
        try {
            result = await db.insert(schemas.templates).values(templateData).returning();
        } catch (error) {
            // Race with a concurrent writer: pre-check passed but the DB unique
            // constraint fired. Surface a clean 409 rather than a raw driver error.
            if (params.slug != null && isSlugUniqueViolation(error)) {
                throw new SlugValidationError(
                    "SLUG_CONFLICT",
                    params.slug,
                    `Template slug "${params.slug}" is already in use.`,
                    409
                );
            }
            throw error;
        }
        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Get template by ID
     */
    static async get(templateId: string): Promise<TemplateConfig | null> {
        const db = await getDB();
        const result = await db
            .select()
            .from(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId))
            .limit(1);

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Get template by UUID (primary key)
     */
    static async getByUuid(uuid: string): Promise<TemplateConfig | null> {
        const db = await getDB();
        const result = await db
            .select()
            .from(schemas.templates)
            .where(eq(schemas.templates.uuid, uuid))
            .limit(1);

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Get template by vanity slug
     */
    static async getBySlug(slug: string): Promise<TemplateConfig | null> {
        const db = await getDB();
        const result = await db
            .select()
            .from(schemas.templates)
            .where(eq(schemas.templates.slug, slug))
            .limit(1);

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Resolve a template by an ambiguous reference (vanity slug OR templateId).
     * Precedence: slug wins (public-facing preferred identifier), then fall back to templateId.
     * Write-time validation guarantees a slug never equals any templateId, so this is deterministic.
     */
    static async resolveByRef(ref: string): Promise<TemplateConfig | null> {
        const bySlug = await Template.getBySlug(ref);
        if (bySlug) {
            return bySlug;
        }
        return Template.get(ref);
    }

    /**
     * Update template
     */
    static async update(
        templateId: string,
        updates: Partial<CreateTemplateParams> & { version?: string }
    ): Promise<TemplateConfig | null> {
        const db = await getDB();

        // Validate slug at the model choke point. Setting slug to null clears it
        // (no validation needed); only a non-null new slug is validated.
        if (updates.slug != null) {
            await validateSlug(updates.slug, {
                selfTemplateId: templateId,
                deps: Template.slugValidationDeps(),
            });
        }

        const updateData: any = {
            updatedAt: new Date(),
        };

        if (updates.slug !== undefined) updateData.slug = updates.slug ?? null;
        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.description !== undefined) updateData.description = updates.description;
        if (updates.tags !== undefined) updateData.tags = updates.tags;
        if (updates.templateType !== undefined) updateData.templateType = updates.templateType;
        if (updates.pricing !== undefined) updateData.pricing = updates.pricing;
        if (updates.reqOptions !== undefined) updateData.reqOptions = updates.reqOptions;
        if (updates.customHandlers !== undefined)
            updateData.customHandlers = updates.customHandlers || null;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;
        if (updates.variables !== undefined) updateData.variables = updates.variables || null;
        if (updates.status !== undefined) updateData.status = updates.status;
        if (updates.reviewStatus !== undefined) updateData.reviewStatus = updates.reviewStatus;
        if (updates.reviewNotes !== undefined) updateData.reviewNotes = updates.reviewNotes;
        if (updates.trusted !== undefined) updateData.trusted = updates.trusted;
        if (updates.version !== undefined) updateData.version = updates.version;

        let result;
        try {
            result = await db
                .update(schemas.templates)
                .set(updateData)
                .where(eq(schemas.templates.templateId, templateId))
                .returning();
        } catch (error) {
            // Race with a concurrent writer on the unique slug column -> clean 409.
            if (updates.slug != null && isSlugUniqueViolation(error)) {
                throw new SlugValidationError(
                    "SLUG_CONFLICT",
                    updates.slug,
                    `Template slug "${updates.slug}" is already in use.`,
                    409
                );
            }
            throw error;
        }

        if (result.length === 0) {
            return null;
        }

        return Template.mapDbToTemplate(result[0]);
    }

    /**
     * Delete template
     */
    static async delete(templateId: string): Promise<boolean> {
        const db = await getDB();
        const result = await db
            .delete(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId))
            .returning();

        return result.length > 0;
    }

    /**
     * Get all templates
     */
    static async getAll(filters?: {
        status?: string;
        createdBy?: string;
        tags?: string[];
    }): Promise<TemplateConfig[]> {
        const db = await getDB();
        let query = db.select().from(schemas.templates);

        if (filters) {
            if (filters.status) {
                query = query.where(eq(schemas.templates.status, filters.status));
            }
            if (filters.createdBy) {
                query = query.where(eq(schemas.templates.createdBy, filters.createdBy));
            }
        }

        const results = await query;
        return results.map((row: any) => Template.mapDbToTemplate(row));
    }

    /**
     * Delete template if exists
     */
    static async deleteIfExists(templateId: string): Promise<void> {
        const db = await getDB();
        await db.delete(schemas.templates).where(eq(schemas.templates.templateId, templateId));
    }

    /**
     * Check if template exists
     */
    static async exists(templateId: string): Promise<boolean> {
        const db = await getDB();
        const result = await db
            .select({ count: sql<number>`count(*)` })
            .from(schemas.templates)
            .where(eq(schemas.templates.templateId, templateId));

        return result[0].count > 0;
    }

    /**
     * Build the DB lookups used by slug validation (anti-ambiguity + uniqueness).
     * Kept here so validateSlug stays DB-agnostic and unit-testable via mock deps.
     */
    private static slugValidationDeps(): SlugValidationDeps {
        return {
            templateIdExists: (candidate: string) => Template.exists(candidate),
            getBySlug: async (slug: string) => {
                const existing = await Template.getBySlug(slug);
                return existing ? { templateId: existing.templateId } : null;
            },
        };
    }

    /**
     * Map database row to TemplateConfig
     */
    private static mapDbToTemplate(row: any): TemplateConfig {
        return {
            uuid: row.uuid,
            templateId: row.templateId,
            slug: row.slug ?? null,
            name: row.name,
            description: row.description,
            tags: row.tags || [],
            version: row.version,
            templateType: row.templateType,
            pricing: row.pricing,
            reqOptions: row.reqOptions,
            customHandlers: row.customHandlers || undefined,
            metadata: row.metadata || {},
            variables: row.variables || undefined,
            createdBy: row.createdBy,
            publishedBy: row.publishedBy,
            reviewedBy: row.reviewedBy,
            status: row.status,
            reviewStatus: row.reviewStatus,
            reviewNotes: row.reviewNotes,
            trusted: row.trusted || false,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            publishedAt: row.publishedAt,
            reviewedAt: row.reviewedAt,
            archivedAt: row.archivedAt,
        };
    }
}
