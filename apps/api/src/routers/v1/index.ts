import express, { Router, ErrorRequestHandler } from "express";
import { ScrapeController } from "../../controllers/v1/ScrapeController.js";
import { BatchScrapeController } from "../../controllers/v1/BatchScrapeController.js";
import { SearchController } from "../../controllers/v1/SearchController.js";
import { CrawlController } from "../../controllers/v1/CrawlController.js";
import { MapController } from "../../controllers/v1/MapController.js";
import { ScheduledTasksController } from "../../controllers/v1/ScheduledTasksController.js";
import { WebhooksController } from "../../controllers/v1/WebhooksController.js";
import { MonitorController } from "../../controllers/v1/MonitorController.js";
import { DatasetController } from "../../controllers/v1/DatasetController.js";
import { TemplateEndpointController } from "../../controllers/v1/TemplateEndpointController.js";
import { TemplateRunController } from "../../controllers/v1/TemplateRunController.js";
import { controllerWrapper } from "../../utils/AsyncHandler.js";
import { checkCreditsMiddleware } from "../../middlewares/CheckCreditsMiddleware.js";

const router: express.Router = Router();
const scrapeController = new ScrapeController();
const batchScrapeController = new BatchScrapeController();
const searchController = new SearchController();
const crawlController = new CrawlController();
const mapController = new MapController();
const scheduledTasksController = new ScheduledTasksController();
const webhooksController = new WebhooksController();
const monitorController = new MonitorController();
const datasetController = new DatasetController();
const templateEndpointController = new TemplateEndpointController();
const templateRunController = new TemplateRunController();

// Billing routes carry the credit gate at their definition (fail-closed). Any new billing route
// MUST attach `checkCreditsMiddleware` here — there is no central allowlist to keep in sync.
router.post("/scrape", checkCreditsMiddleware, controllerWrapper(scrapeController.handle));
router.post("/search", checkCreditsMiddleware, controllerWrapper(searchController.handle));
router.post("/map", checkCreditsMiddleware, controllerWrapper(mapController.map));

// Per-template dedicated endpoints (dispatches to scrape/search/crawl by template type).
// Exact sub-paths (/execute) take precedence over the bare `:templateRef` param in Express.
router.get("/template/:templateRef", controllerWrapper(templateEndpointController.spec));
router.post("/template/:templateRef/execute", checkCreditsMiddleware, controllerWrapper(templateEndpointController.execute));

// Template Run Core API (async run lifecycle nested under the template resource).
// Only the create route is billable (fail-closed credit gate); the read/cancel
// routes are NOT billed and MUST NOT carry checkCreditsMiddleware.
router.post("/template/:templateRef/runs", checkCreditsMiddleware, controllerWrapper(templateRunController.create));
router.get("/template/:templateRef/runs", controllerWrapper(templateRunController.list));
router.get("/template/:templateRef/runs/:run_id", controllerWrapper(templateRunController.get));
router.post("/template/:templateRef/runs/:run_id/cancel", controllerWrapper(templateRunController.cancel));
router.get("/template/:templateRef/runs/:run_id/events", controllerWrapper(templateRunController.events));
router.get("/template/:templateRef/runs/:run_id/warnings", controllerWrapper(templateRunController.warnings));
router.get("/template/:templateRef/runs/:run_id/dataset", controllerWrapper(templateRunController.dataset));

// Batch scrape routes (async job model)
router.post("/batch/scrape", checkCreditsMiddleware, controllerWrapper(batchScrapeController.start));
router.get("/batch/scrape/:jobId/status", controllerWrapper(batchScrapeController.status));
router.get("/batch/scrape/:jobId", controllerWrapper(batchScrapeController.results));
router.delete("/batch/scrape/:jobId", controllerWrapper(batchScrapeController.cancel));

// Crawl routes
router.post("/crawl", checkCreditsMiddleware, controllerWrapper(crawlController.start));
router.get("/crawl/:jobId/status", controllerWrapper(crawlController.status));
router.get("/crawl/:jobId", controllerWrapper(crawlController.results));
router.delete("/crawl/:jobId", controllerWrapper(crawlController.cancel));

// Scheduled tasks routes
router.post("/scheduled-tasks", controllerWrapper(scheduledTasksController.create));
router.get("/scheduled-tasks", controllerWrapper(scheduledTasksController.list));
router.get("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.get));
router.put("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.update));
router.patch("/scheduled-tasks/:taskId/pause", controllerWrapper(scheduledTasksController.pause));
router.patch("/scheduled-tasks/:taskId/resume", controllerWrapper(scheduledTasksController.resume));
router.delete("/scheduled-tasks/:taskId", controllerWrapper(scheduledTasksController.delete));
router.get("/scheduled-tasks/:taskId/executions", controllerWrapper(scheduledTasksController.executions));
router.delete("/scheduled-tasks/:taskId/executions/:executionId", controllerWrapper(scheduledTasksController.cancelExecution));

// Webhooks routes
router.post("/webhooks", controllerWrapper(webhooksController.create));
router.get("/webhooks", controllerWrapper(webhooksController.list));
router.get("/webhooks/:webhookId", controllerWrapper(webhooksController.get));
router.put("/webhooks/:webhookId", controllerWrapper(webhooksController.update));
router.delete("/webhooks/:webhookId", controllerWrapper(webhooksController.delete));
router.get("/webhooks/:webhookId/deliveries", controllerWrapper(webhooksController.deliveries));
router.post("/webhooks/:webhookId/test", controllerWrapper(webhooksController.test));
router.put("/webhooks/:webhookId/activate", controllerWrapper(webhooksController.activate));
router.put("/webhooks/:webhookId/deactivate", controllerWrapper(webhooksController.deactivate));
router.post("/webhooks/:webhookId/deliveries/:deliveryId/replay", controllerWrapper(webhooksController.replayDelivery));
router.get("/webhook-events", controllerWrapper(webhooksController.getEvents));

// Monitor routes
router.post("/monitors", controllerWrapper(monitorController.create));
router.get("/monitors", controllerWrapper(monitorController.list));
router.get("/monitors/:id", controllerWrapper(monitorController.get));
router.patch("/monitors/:id", controllerWrapper(monitorController.update));
router.delete("/monitors/:id", controllerWrapper(monitorController.delete));
router.post("/monitors/:id/pause", controllerWrapper(monitorController.pause));
router.post("/monitors/:id/resume", controllerWrapper(monitorController.resume));
router.post("/monitors/:id/check", controllerWrapper(monitorController.check));
router.get("/monitors/:id/snapshots", controllerWrapper(monitorController.snapshots));
router.get("/monitors/:id/snapshots/:snapshotId", controllerWrapper(monitorController.snapshotDetail));
router.get("/monitors/:id/changes", controllerWrapper(monitorController.changes));
router.get("/monitors/:id/changes/:changeId", controllerWrapper(monitorController.changeDetail));

// Dataset routes (READ + management). Dataset reads/writes are NOT billed in v1 —
// do NOT attach checkCreditsMiddleware to any dataset route.
router.post("/datasets", controllerWrapper(datasetController.create));
router.get("/datasets", controllerWrapper(datasetController.list));
router.get("/datasets/:id", controllerWrapper(datasetController.get));
router.patch("/datasets/:id", controllerWrapper(datasetController.update));
router.delete("/datasets/:id", controllerWrapper(datasetController.delete));
router.get("/datasets/:id/items", controllerWrapper(datasetController.items));
router.get("/datasets/:id/runs", controllerWrapper(datasetController.runs));
router.get("/datasets/:id/runs/:run_id", controllerWrapper(datasetController.run));
router.get("/datasets/:id/runs/:run_id/items", controllerWrapper(datasetController.runItems));
router.get("/datasets/:id/runs/:run_id/warnings", controllerWrapper(datasetController.runWarnings));
router.get("/datasets/:id/changes", controllerWrapper(datasetController.changes));
router.post("/datasets/:id/exports", controllerWrapper(datasetController.createExport));
router.get("/datasets/:id/exports", controllerWrapper(datasetController.listExports));
router.get("/datasets/:id/exports/:export_id", controllerWrapper(datasetController.getExport));

// Error handler
router.use(((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send("Something broke!");
}) as ErrorRequestHandler);

export default router;
