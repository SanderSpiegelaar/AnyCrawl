import { eq, and, gt, gte, sql, desc } from "drizzle-orm";
import { getDB, schemas } from "./db/index.js";
import { STATUS, JOB_RESULT_STATUS } from "./map.js";
import { Job, CreateJobParams } from "./model/Job.js";
import { Template, CreateTemplateParams } from "./model/Template.js";
import { Billing } from "./model/Billing.js";
import {
    buildTaskWhereClause as buildTaskWhereClauseByOwner,
    buildWebhookWhereClause as buildWebhookWhereClauseByOwner,
    getOwnedTask as getOwnedTaskByOwner,
    listTasksByOwner as listTasksByOwnerOwner,
    getOwnedWebhook as getOwnedWebhookByOwner,
    listWebhooksByOwner as listWebhooksByOwnerOwner,
} from "./model/OwnerAccess.js";
import {
    buildMonitorWhereClause as buildMonitorWhereClauseByOwner,
    getOwnedMonitor as getOwnedMonitorByOwner,
    listMonitorsByOwner as listMonitorsByOwnerOwner,
    getMonitorByScheduledTask as getMonitorByScheduledTaskFn,
    getLatestSnapshot as getLatestSnapshotFn,
    listSnapshotsByMonitor as listSnapshotsByMonitorFn,
    getSnapshotForMonitor as getSnapshotForMonitorFn,
    listChangesByMonitor as listChangesByMonitorFn,
} from "./model/MonitorAccess.js";
import {
    buildDatasetWhereClause as buildDatasetWhereClauseByOwner,
    getOwnedDataset as getOwnedDatasetByOwner,
    getDataset as getDatasetFn,
    resolveDatasetOwnerScope as resolveDatasetOwnerScopeFn,
} from "./model/DatasetAccess.js";
import { Dataset } from "./model/Dataset.js";
import { DatasetWriter } from "./model/DatasetWriter.js";
import { TemplateRevision } from "./model/TemplateRevision.js";
import { TemplateRun } from "./model/TemplateRun.js";
import { TemplateRunRequest } from "./model/TemplateRunRequest.js";
import {
    buildTemplateRunWhereClause as buildTemplateRunWhereClauseByOwner,
    getOwnedTemplateRun as getOwnedTemplateRunByOwner,
    listTemplateRunsByOwner as listTemplateRunsByOwnerOwner,
    listTemplateRunWarnings as listTemplateRunWarningsFn,
    resolveTemplateRunOwnerScope as resolveTemplateRunOwnerScopeFn,
} from "./model/TemplateRunAccess.js";

// Backward compatibility functions
export const createJob = Job.create;
export const getJob = Job.get;
export const cancelJob = Job.cancel;
export const updateJobStatus = Job.updateStatus;
export const failedJob = Job.markAsFailed;
export const completedJob = Job.markAsCompleted;
export const insertJobResult = Job.insertJobResult;
export const getJobResults = Job.getJobResults;
export const getJobResultsPaginated = Job.getJobResultsPaginated;
export const getJobResultsCount = Job.getJobResultsCount;
export const updateJobCounts = Job.updateCounts;
export const updateJobCacheHits = Job.updateCacheHits;
export const addJobTraffic = Job.addTraffic;

export const createTemplate = Template.create;
export const getTemplate = Template.get;
export const getTemplateBySlug = Template.getBySlug;
export const resolveTemplateByRef = Template.resolveByRef;
export const getTemplateByUuid = Template.getByUuid;
export const updateTemplate = Template.update;
export const deleteTemplate = Template.delete;
export const deleteTemplateIfExists = Template.deleteIfExists;
export const existsTemplate = Template.exists;

// Template revisions (L3) — immutable version snapshots + get-or-create freeze.
export const createTemplateRevision = TemplateRevision.freeze;
export const getTemplateRevision = TemplateRevision.get;
export const listTemplateRevisions = TemplateRevision.listByTemplate;
export const freezeCurrentTemplateRevision = TemplateRevision.freezeCurrentAndSetPointer;
export const computeTemplateConfigHash = TemplateRevision.computeConfigHash;

// Template runs (L3 Phase 3) — unified async run core: create (idempotent),
// lifecycle transitions, cancel, finalize, and the /events audit feed.
export const createTemplateRun = TemplateRun.create;
export const getTemplateRun = TemplateRun.get;
export const getTemplateRunByIdempotency = TemplateRun.getByIdempotency;
export const updateTemplateRunStatus = TemplateRun.updateStatus;
export const requestTemplateRunCancel = TemplateRun.requestCancel;
export const finalizeTemplateRun = TemplateRun.finalize;
export const appendTemplateRunEvent = TemplateRun.appendEvent;
export const listTemplateRunEvents = TemplateRun.listEvents;

// Template run requests (L3 Phase 4) — orchestrated request ledger: idempotent
// enqueue, get, list-by-run, status patch, atomic claim, and status counts.
export const enqueueTemplateRunRequest = TemplateRunRequest.enqueue;
export const getTemplateRunRequest = TemplateRunRequest.get;
export const listTemplateRunRequestsByRun = TemplateRunRequest.listByRun;
export const updateTemplateRunRequestStatus = TemplateRunRequest.updateStatus;
export const claimNextTemplateRunRequest = TemplateRunRequest.claimNext;
export const countTemplateRunRequestsByStatus = TemplateRunRequest.countByStatus;

// Template run ownership + access helpers
export const buildTemplateRunWhereClause = buildTemplateRunWhereClauseByOwner;
export const getOwnedTemplateRun = getOwnedTemplateRunByOwner;
export const listTemplateRunsByOwner = listTemplateRunsByOwnerOwner;
export const listTemplateRunWarnings = listTemplateRunWarningsFn;
export const resolveTemplateRunOwnerScope = resolveTemplateRunOwnerScopeFn;

export const chargeDeltaByJobId = Billing.chargeDeltaByJobId;
export const chargeToUsedByJobId = Billing.chargeToUsedByJobId;
export const buildTaskWhereClause = buildTaskWhereClauseByOwner;
export const buildWebhookWhereClause = buildWebhookWhereClauseByOwner;
export const getOwnedTask = getOwnedTaskByOwner;
export const listTasksByOwner = listTasksByOwnerOwner;
export const getOwnedWebhook = getOwnedWebhookByOwner;
export const listWebhooksByOwner = listWebhooksByOwnerOwner;

// Monitor ownership + access helpers
export const buildMonitorWhereClause = buildMonitorWhereClauseByOwner;
export const getOwnedMonitor = getOwnedMonitorByOwner;
export const listMonitorsByOwner = listMonitorsByOwnerOwner;
export const getMonitorByScheduledTask = getMonitorByScheduledTaskFn;
export const getLatestSnapshot = getLatestSnapshotFn;
export const listSnapshotsByMonitor = listSnapshotsByMonitorFn;
export const getSnapshotForMonitor = getSnapshotForMonitorFn;
export const listChangesByMonitor = listChangesByMonitorFn;

// Dataset ownership + access helpers
export const buildDatasetWhereClause = buildDatasetWhereClauseByOwner;
export const getOwnedDataset = getOwnedDatasetByOwner;
export const getDataset = getDatasetFn;
export const resolveDatasetOwnerScope = resolveDatasetOwnerScopeFn;

// Dataset model (create + list/read query helpers)
export const createDataset = Dataset.create;
export const updateDataset = Dataset.update;
export const softDeleteDataset = Dataset.softDelete;
export const listDatasetsByOwner = Dataset.listByOwner;
// Returns the queryable-field catalog Map<field, { path, type }> read from
// datasets.query_fields (used by the controller to validate + resolve filter/sort).
export const getDatasetProjectionFields = Dataset.getProjectionCatalog;
export const getDatasetByOwnerAndName = Dataset.getByOwnerAndName;
export const getDatasetItems = Dataset.getItems;
export const listDatasetRuns = Dataset.listRuns;
export const getDatasetRun = Dataset.getRun;
export const listDatasetRunItems = Dataset.listRunItems;
export const listDatasetChanges = Dataset.listChanges;
export const listRunWarnings = Dataset.listRunWarnings;

// Dataset Writer (producer write-path service). Additive: only invoked when a
// request carries `output.dataset` — the no-dataset path is untouched.
export const writeResultToDataset = DatasetWriter.writeResultToDataset.bind(DatasetWriter);
export const finalizeCrawlDatasetRun = DatasetWriter.finalizeCrawlDatasetRun.bind(DatasetWriter);
export const assertDatasetWritable = DatasetWriter.assertDatasetWritable.bind(DatasetWriter);
export const parseDatasetOutput = DatasetWriter.parseOutput.bind(DatasetWriter);
export const standardDatasetMapping = DatasetWriter.standardMapping.bind(DatasetWriter);
export {
    DatasetWriter,
    DatasetWriteError,
    DatasetNotFoundError,
    DatasetSchemaMismatchError,
} from "./model/DatasetWriter.js";
export type {
    WriteResultToDatasetParams,
    WriteResultToDatasetOutcome,
    DatasetRunStatus,
    DatasetScopeType,
    DatasetMapping,
    DatasetTarget,
    DatasetCreateSpec,
    DatasetProjectionSpec,
    ParsedDatasetOutput,
    RunWarning as DatasetRunWarning,
} from "./model/DatasetWriter.js";
export { computeDocumentHash, shallowFieldDiff } from "./model/documentHash.js";

// Template system exports
export { templates, templateExecutions, templateRevisions, billingLedger } from "./db/schemas/PostgreSQL.js";

// Template run (L3 Phase 3) table exports
export { templateRuns, templateRunEvents } from "./db/schemas/PostgreSQL.js";

// Template run request (L3 Phase 4) table export
export { templateRunRequests } from "./db/schemas/PostgreSQL.js";

// Scheduled tasks and webhooks exports
export {
    scheduledTasks,
    taskExecutions,
    webhookSubscriptions,
    webhookDeliveries,
    pageCache,
    mapCache,
} from "./db/schemas/PostgreSQL.js";

// Monitor table exports
export {
    monitors,
    monitorSnapshots,
    monitorChanges,
} from "./db/schemas/PostgreSQL.js";

// Dataset (L2) table exports
export {
    datasets,
    datasetRuns,
    datasetItems,
    datasetRunItems,
    datasetItemScopes,
    datasetItemChanges,
    runWarnings,
} from "./db/schemas/PostgreSQL.js";

export { eq, and, gt, gte, sql, desc, getDB, schemas, STATUS, JOB_RESULT_STATUS, Job, Billing, Dataset, TemplateRevision, TemplateRun, TemplateRunRequest };
export { TEMPLATE_RUN_TERMINAL_STATUSES } from "./model/TemplateRun.js";
export type { CreateJobParams, CreateTemplateParams };
export type { FreezeRevisionParams } from "./model/TemplateRevision.js";
export type {
    CreateTemplateRunParams,
    UpdateTemplateRunStatusPatch,
    FinalizeTemplateRunExtras,
    TemplateRunMode,
    TemplateRunStatus,
    TemplateRunTerminalStatus,
} from "./model/TemplateRun.js";
export type {
    EnqueueTemplateRunRequestParams,
    UpdateTemplateRunRequestPatch,
    ClaimNextOptions,
    TemplateRunRequestType,
    TemplateRunRequestStatus,
} from "./model/TemplateRunRequest.js";
export type {
    FieldType as DatasetFieldType,
    FilterOp as DatasetFilterOp,
    ItemFilter as DatasetItemFilter,
    ItemSort as DatasetItemSort,
    CursorKey as DatasetCursorKey,
    PageResult as DatasetPageResult,
    ProjectionCatalogEntry as DatasetProjectionCatalogEntry,
} from "./model/Dataset.js";

// Slug write-path validation (design doc §5.7). Exported so API callers can map
// SlugValidationError.httpStatus/code to HTTP 400/409 responses.
export {
    validateSlug,
    validateSlugFormat,
    isSlugUniqueViolation,
    SlugValidationError,
    SLUG_REGEX,
    SLUG_MIN_LENGTH,
    SLUG_MAX_LENGTH,
    RESERVED_SLUGS,
} from "./model/slug.js";
export type {
    SlugValidationDeps,
    SlugValidationErrorCode,
    ValidateSlugOptions,
} from "./model/slug.js";
