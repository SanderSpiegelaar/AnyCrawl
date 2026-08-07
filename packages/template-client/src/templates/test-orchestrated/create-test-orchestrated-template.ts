#!/usr/bin/env node
import { createRequire } from "node:module";
import { getDB, createTemplate, deleteTemplateIfExists } from "@anycrawl/db";
import type { TemplateConfig } from "@anycrawl/libs";

/**
 * Seed / register the minimal `test-orchestrated` template.
 *
 * The authoritative, self-contained definition lives next to this file in
 * `test-orchestrated.template.json` (runtime, outputSchema, variables and the
 * inline `customHandlers.seedHandler` / `customHandlers.requestHandler`
 * sources). This script maps that config onto the same columns that
 * `@anycrawl/db` Template.create persists — identical shape to
 * `create-craigslist-template.ts`.
 *
 * `runtime` and `outputSchema` are the top-level L3 config fields the JSON
 * authors; they persist to dedicated nullable `templates.runtime` /
 * `templates.output_schema` columns so an orchestrated template resolves with
 * `runtime.mode` set and the frozen revision snapshot carries them.
 * `customHandlers` is stored verbatim as jsonb, so the `seedHandler` key is
 * preserved.
 */
const require = createRequire(import.meta.url);
const config = require("./test-orchestrated.template.json") as Record<string, any>;

export async function createTestOrchestratedTemplate(): Promise<TemplateConfig> {
    console.log("🚀 Registering test-orchestrated template...");

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
        runtime: config.runtime,
        outputSchema: config.outputSchema,
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
    console.log(`   default urls      : ${JSON.stringify(config.variables?.urls?.defaultValue)}`);

    return result;
}
