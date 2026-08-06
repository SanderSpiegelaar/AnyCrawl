#!/usr/bin/env node
import { createRequire } from "node:module";
import { getDB, createTemplate, deleteTemplateIfExists } from "@anycrawl/db";
import type { TemplateConfig } from "@anycrawl/libs";

/**
 * Seed / register the Craigslist all-in-one template.
 *
 * The authoritative, self-contained definition lives next to this file in
 * `craigslist-all-in-one.template.json` (runtime, outputSchema, variables and
 * the inline `customHandlers.seedHandler` / `customHandlers.requestHandler`
 * sources). This script maps that config onto the same columns that
 * `@anycrawl/db` Template.create persists — identical shape to
 * `src/libs/create-template.ts`, which is how templates are registered in this
 * repo.
 *
 * Note: `runtime` and `outputSchema` are L3 config/revision-snapshot fields and
 * have no dedicated `templates` columns yet, so (like the existing seed script)
 * they are not part of the column insert; `customHandlers` is stored verbatim as
 * jsonb, so the `seedHandler` key is preserved.
 */
const require = createRequire(import.meta.url);
const config = require("./craigslist-all-in-one.template.json") as Record<string, any>;

export async function createCraigslistTemplate(): Promise<TemplateConfig> {
    console.log("🚀 Registering Craigslist all-in-one template...");

    // Ensure the database connection is initialized.
    await getDB();

    // Replace any previous copy so re-running is idempotent.
    await deleteTemplateIfExists(config.templateId);

    const result = await createTemplate({
        templateId: config.templateId,
        slug: config.slug ?? null,
        name: config.name,
        description: config.description,
        tags: config.tags,
        templateType: config.templateType,
        pricing: config.pricing,
        reqOptions: config.reqOptions,
        customHandlers: config.customHandlers, // includes seedHandler + requestHandler
        metadata: config.metadata,
        variables: config.variables,
        createdBy: config.createdBy,
        publishedBy: config.publishedBy,
        reviewedBy: config.reviewedBy,
        status: config.status,
        reviewStatus: config.reviewStatus,
        reviewNotes: config.reviewNotes,
        trusted: config.trusted,
    });

    console.log("✅ Template registered:", result.templateId);
    console.log(`   runtime.mode      : ${config.runtime?.mode}`);
    console.log(`   seedBuilder       : ${JSON.stringify(config.runtime?.seedBuilder)}`);
    console.log(`   outputSchema      : ${config.outputSchema?.name}@${config.outputSchema?.version}`);
    console.log(`   allowedDomains    : ${JSON.stringify(config.metadata?.allowedDomains?.patterns)}`);
    console.log(`   catalog cities    : ${Object.keys(config.metadata?.catalog?.cities || {}).length}`);
    console.log(`   catalog categories: ${Object.keys(config.metadata?.catalog?.categories || {}).length}`);

    return result;
}
