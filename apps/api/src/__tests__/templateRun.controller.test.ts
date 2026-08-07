import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// --- Mocked collaborators (shared spies) -----------------------------------
const resolveTemplateByRef = jest.fn<(ref: string) => Promise<any>>();
const freezeCurrentTemplateRevision = jest.fn<(id: string) => Promise<any>>();
const createTemplateRun = jest.fn<(params: any) => Promise<any>>();
const getTemplateRun = jest.fn<(uuid: string) => Promise<any>>();
const getTemplateRunByIdempotency = jest.fn<(t: string, h: string) => Promise<any>>();
const getOwnedTemplateRun = jest.fn<(db: any, id: string, owner: any) => Promise<any>>();
const listTemplateRunsByOwner = jest.fn<(db: any, owner: any, opts: any) => Promise<any>>();
const listTemplateRunEvents = jest.fn<(id: string, opts: any) => Promise<any>>();
const listTemplateRunWarnings = jest.fn<(db: any, id: string, opts: any) => Promise<any>>();
const requestTemplateRunCancel = jest.fn<(id: string) => Promise<any>>();
const finalizeTemplateRun = jest.fn<(id: string, s: string, e?: any) => Promise<any>>();
const getJob = jest.fn<(id: string) => Promise<any>>();
const getDB = jest.fn(async () => ({}));
const computeDocumentHash = jest.fn((v: unknown) => `hash:${JSON.stringify(v)}`);

// Orchestrated dispatch collaborators (exercised through the real OrchestratedRunAdapter).
const appendTemplateRunEvent = jest.fn<(id: string, t: string, p?: any) => Promise<any>>(async () => ({}));
const updateTemplateRunStatus = jest.fn<(id: string, patch: any) => Promise<any>>(async () => ({}));
const parseDatasetOutput = jest.fn<(raw: unknown, opts: any) => any>(() => null);
const assertDatasetWritable = jest.fn<(params: any) => Promise<void>>(async () => {});
class DatasetWriteError extends Error {
    code: string;
    httpStatus: number;
    constructor(code: string, message: string, httpStatus: number) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
    }
}
const addTemplateRunJob = jest.fn<(payload: any) => Promise<string>>(async () => "bull-job-1");

const hasTemplateAccess = jest.fn<(template: any, userId?: string) => boolean>();
const mergeRequestWithTemplate = jest.fn<(body: any, type: string, uid?: string) => Promise<any>>();

const executeSingleRun = jest.fn<(params: any) => Promise<any>>();
const startCrawlRun = jest.fn<(params: any) => Promise<any>>();
const cancelCrawlJob = jest.fn<(jobId: string) => Promise<any>>();

jest.unstable_mockModule("@anycrawl/db", () => ({
    resolveTemplateByRef,
    freezeCurrentTemplateRevision,
    createTemplateRun,
    getTemplateRun,
    getTemplateRunByIdempotency,
    getOwnedTemplateRun,
    listTemplateRunsByOwner,
    listTemplateRunEvents,
    listTemplateRunWarnings,
    requestTemplateRunCancel,
    finalizeTemplateRun,
    getJob,
    getDB,
    computeDocumentHash,
    appendTemplateRunEvent,
    updateTemplateRunStatus,
    parseDatasetOutput,
    assertDatasetWritable,
    DatasetWriteError,
    STATUS: { PENDING: "pending", COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled" },
    TEMPLATE_RUN_TERMINAL_STATUSES: ["completed", "partial", "failed", "cancelled"],
}));

jest.unstable_mockModule("@anycrawl/scrape", () => ({
    QueueManager: { getInstance: () => ({ addTemplateRunJob }) },
}));

jest.unstable_mockModule("../utils/templateHandler.js", () => ({
    TemplateHandler: { hasTemplateAccess, mergeRequestWithTemplate },
}));

jest.unstable_mockModule("../services/LegacyRunAdapter.js", () => ({
    LegacyRunAdapter: class {
        executeSingleRun = executeSingleRun;
        startCrawlRun = startCrawlRun;
        cancelCrawlJob = cancelCrawlJob;
    },
}));

const { TemplateRunController } = await import("../controllers/v1/TemplateRunController.js");

// --- Test doubles -----------------------------------------------------------
function mockRes(): any {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body: any) => {
        res.body = body;
        return res;
    };
    return res;
}

function mockReq(templateRef: string, body: any = {}, headers: any = {}): any {
    return {
        params: { templateRef },
        body,
        headers,
        query: {},
        auth: { user: "user-1", uuid: "key-1" },
        get: (name: string) => headers[name.toLowerCase()],
    };
}

const scrapeTemplate = {
    uuid: "tpl-uuid-1",
    templateId: "content-extractor",
    slug: "content-extractor",
    templateType: "scrape",
    name: "Content Extractor",
    version: "1.0.0",
    pricing: { perCall: 1, currency: "credits" },
    metadata: {},
};
const searchTemplate = { ...scrapeTemplate, templateType: "search" };
const crawlTemplate = { ...scrapeTemplate, templateType: "crawl" };
const orchestratedTemplate = {
    ...scrapeTemplate,
    runtime: { mode: "orchestrated" },
    reqOptions: { engine: "cheerio" },
    outputSchema: {
        name: "craigslist_listing",
        version: "1.0.0",
        itemsPath: "/items",
        itemKeyPath: "/itemKey",
        hashExcludePaths: ["/provenance/scrapedAt"],
        projections: [{ field: "id", path: "/id", type: "string" }],
    },
};

const queuedRun = {
    uuid: "run-uuid-1",
    templateUuid: "tpl-uuid-1",
    templateRevisionUuid: "rev-1",
    mode: "single",
    status: "queued",
    createdAt: new Date("2026-08-06T00:00:00Z"),
};

beforeEach(() => {
    jest.clearAllMocks();
    hasTemplateAccess.mockReturnValue(true);
    freezeCurrentTemplateRevision.mockResolvedValue({ uuid: "rev-1" });
    mergeRequestWithTemplate.mockImplementation(async (body: any) => body);
    createTemplateRun.mockResolvedValue(queuedRun);
    getTemplateRunByIdempotency.mockResolvedValue(null);
});

describe("TemplateRunController.create", () => {
    it("returns 404 when the template ref cannot be resolved", async () => {
        resolveTemplateByRef.mockResolvedValue(null);
        const res = mockRes();
        await new TemplateRunController().create(mockReq("unknown", { url: "https://x.com" }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("template_not_found");
        expect(createTemplateRun).not.toHaveBeenCalled();
        expect(executeSingleRun).not.toHaveBeenCalled();
    });

    it("returns 403 when the user lacks access to the template", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        hasTemplateAccess.mockReturnValue(false);
        const res = mockRes();
        await new TemplateRunController().create(mockReq("content-extractor", { url: "https://x.com" }), res);

        expect(res.statusCode).toBe(403);
        expect(res.body.data.type).toBe("ACCESS_DENIED");
        expect(createTemplateRun).not.toHaveBeenCalled();
    });

    it("dispatches an orchestrated run to the template-run worker and returns running (202)", async () => {
        resolveTemplateByRef.mockResolvedValue(orchestratedTemplate);
        createTemplateRun.mockResolvedValue({ ...queuedRun, mode: "orchestrated" });
        getTemplateRun.mockResolvedValue({
            ...queuedRun,
            mode: "orchestrated",
            status: "running",
            legacyJobUuid: "bull-job-1",
        });

        const res = mockRes();
        await new TemplateRunController().create(
            mockReq("content-extractor", { variables: { cities: ["sfbay"] } }),
            res
        );

        // A run is created in orchestrated mode, then enqueued (never run inline).
        expect(freezeCurrentTemplateRevision).toHaveBeenCalledTimes(1);
        expect(createTemplateRun).toHaveBeenCalledTimes(1);
        expect((createTemplateRun.mock.calls[0]![0] as any).mode).toBe("orchestrated");
        expect(executeSingleRun).not.toHaveBeenCalled();
        expect(startCrawlRun).not.toHaveBeenCalled();

        // The template-run job carries the run id, frozen revision, engine + mapping.
        expect(addTemplateRunJob).toHaveBeenCalledTimes(1);
        const payload = addTemplateRunJob.mock.calls[0]![0] as any;
        expect(payload.type).toBe("template-run");
        expect(payload.runId).toBe("run-uuid-1");
        expect(payload.templateRevisionId).toBe("rev-1");
        expect(payload.templateUuid).toBe("tpl-uuid-1");
        expect(payload.engine).toBe("cheerio");
        expect(payload.variables).toEqual({ cities: ["sfbay"] });
        expect(payload.dataset.mapping.name).toBe("craigslist_listing");
        expect(payload.dataset.mapping.projections[0]).toEqual({ name: "id", path: "/id", type: "string" });
        expect(payload.dataset.create.name).toBe("craigslist_listing");

        // Run is moved to running and the response is 202.
        // NOTE: orchestrated runs must NOT set legacyJobUuid — the template-run BullMQ job
        // is not a `jobs` row (legacy_job_uuid FKs to jobs). The BullMQ jobId == run.uuid.
        const statusCall = (updateTemplateRunStatus as jest.Mock).mock.calls.find(
            (c: any[]) => c[0] === "run-uuid-1" && c[1]?.status === "running"
        ) as any[] | undefined;
        expect(statusCall).toBeTruthy();
        expect((statusCall as any[])[1].legacyJobUuid).toBeUndefined();
        expect(res.statusCode).toBe(202);
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe("running");
        expect(res.body.data.legacy_job_id).toBe("bull-job-1");
    });

    it("fails an orchestrated run 400 when the template declares no outputSchema", async () => {
        resolveTemplateByRef.mockResolvedValue({ ...orchestratedTemplate, outputSchema: undefined });
        createTemplateRun.mockResolvedValue({ ...queuedRun, mode: "orchestrated" });
        getTemplateRun.mockResolvedValue({ ...queuedRun, mode: "orchestrated", status: "failed" });

        const res = mockRes();
        await new TemplateRunController().create(
            mockReq("content-extractor", { variables: { cities: ["sfbay"] } }),
            res
        );

        // Row is created, then finalized failed — never enqueued, never left queued.
        expect(createTemplateRun).toHaveBeenCalledTimes(1);
        expect(addTemplateRunJob).not.toHaveBeenCalled();
        expect(finalizeTemplateRun).toHaveBeenCalledWith(
            "run-uuid-1",
            "failed",
            expect.objectContaining({ errorCode: "output_schema_required" })
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe("output_schema_required");
    });

    it("propagates a 409 dataset schema mismatch from the orchestrated dispatch", async () => {
        resolveTemplateByRef.mockResolvedValue(orchestratedTemplate);
        createTemplateRun.mockResolvedValue({ ...queuedRun, mode: "orchestrated" });
        getTemplateRun.mockResolvedValue({ ...queuedRun, mode: "orchestrated", status: "failed" });
        parseDatasetOutput.mockReturnValueOnce({ return: "items", dataset: { datasetId: "ds-existing" } });
        assertDatasetWritable.mockRejectedValueOnce(
            new DatasetWriteError("dataset_schema_mismatch", "schema mismatch", 409)
        );

        const res = mockRes();
        await new TemplateRunController().create(
            mockReq("content-extractor", {
                variables: { cities: ["sfbay"] },
                output: { dataset: { dataset_id: "ds-existing" } },
            }),
            res
        );

        expect(addTemplateRunJob).not.toHaveBeenCalled();
        expect(finalizeTemplateRun).toHaveBeenCalledWith(
            "run-uuid-1",
            "failed",
            expect.objectContaining({ errorCode: "dataset_schema_mismatch" })
        );
        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe("dataset_schema_mismatch");
    });

    it("runs a single scrape via the adapter and returns the terminal run (201)", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        executeSingleRun.mockResolvedValue({
            ok: true,
            httpStatus: 200,
            result: { markdown: "hi" },
            jobId: "job-1",
            datasetOutcome: { dataset_id: "ds-1", dataset_run_id: "dr-1", status: "completed" },
        });
        getTemplateRun.mockResolvedValue({ ...queuedRun, status: "completed", datasetId: "ds-1", datasetRunUuid: "dr-1" });

        const res = mockRes();
        await new TemplateRunController().create(mockReq("content-extractor", { url: "https://x.com" }), res);

        expect(executeSingleRun).toHaveBeenCalledTimes(1);
        expect(startCrawlRun).not.toHaveBeenCalled();
        // adapter receives the raw (un-merged) delegated body with template_id set
        const passed = executeSingleRun.mock.calls[0]![0] as any;
        expect(passed.delegatedBody.template_id).toBe("content-extractor");
        expect(passed.run).toBe(queuedRun);
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.run_id).toBe("run-uuid-1");
        expect(res.body.data.status).toBe("completed");
        expect(res.body.data.dataset_id).toBe("ds-1");
        expect(res.body.data.result).toEqual({ markdown: "hi" });
    });

    it("dispatches a single crawl asynchronously and returns running (202)", async () => {
        resolveTemplateByRef.mockResolvedValue(crawlTemplate);
        startCrawlRun.mockResolvedValue({ ok: true, httpStatus: 200, jobId: "job-2", datasetId: "ds-2", body: {} });
        getTemplateRun.mockResolvedValue({ ...queuedRun, status: "running", legacyJobUuid: "job-2", datasetId: "ds-2" });

        const res = mockRes();
        await new TemplateRunController().create(mockReq("content-extractor", { url: "https://x.com" }), res);

        expect(startCrawlRun).toHaveBeenCalledTimes(1);
        expect(executeSingleRun).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(202);
        expect(res.body.data.status).toBe("running");
        expect(res.body.data.legacy_job_id).toBe("job-2");
        expect(res.body.data.dataset_id).toBe("ds-2");
    });

    it("dispatches a single search via executeSingleRun", async () => {
        resolveTemplateByRef.mockResolvedValue(searchTemplate);
        executeSingleRun.mockResolvedValue({ ok: true, httpStatus: 200, result: [], jobId: "job-3", datasetOutcome: null });
        getTemplateRun.mockResolvedValue({ ...queuedRun, status: "completed" });

        const res = mockRes();
        await new TemplateRunController().create(mockReq("news-search", { query: "hello" }), res);

        expect(executeSingleRun).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(201);
    });

    it("is idempotent: an existing run for the same key is returned with 200", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        const existing = { ...queuedRun, uuid: "run-existing", status: "completed", normalizedInputHash: undefined };
        getTemplateRunByIdempotency.mockResolvedValue(existing);

        const res = mockRes();
        await new TemplateRunController().create(
            mockReq("content-extractor", { url: "https://x.com" }, { "idempotency-key": "abc" }),
            res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.data.run_id).toBe("run-existing");
        expect(createTemplateRun).not.toHaveBeenCalled();
        expect(executeSingleRun).not.toHaveBeenCalled();
    });

    it("returns 409 when the same idempotency key carries a different payload", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        getTemplateRunByIdempotency.mockResolvedValue({ ...queuedRun, normalizedInputHash: "different-hash" });

        const res = mockRes();
        await new TemplateRunController().create(
            mockReq("content-extractor", { url: "https://x.com" }, { "idempotency-key": "abc" }),
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe("idempotency_conflict");
        expect(createTemplateRun).not.toHaveBeenCalled();
    });

    it("maps a variable merge failure to 400 invalid_variables", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        mergeRequestWithTemplate.mockRejectedValue(new Error("Required variable 'foo' is missing"));

        const res = mockRes();
        await new TemplateRunController().create(mockReq("content-extractor", { url: "https://x.com" }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe("invalid_variables");
        expect(createTemplateRun).not.toHaveBeenCalled();
    });
});

describe("TemplateRunController.get / cancel", () => {
    it("returns 404 when the run does not belong to the path template", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        getOwnedTemplateRun.mockResolvedValue({ ...queuedRun, templateUuid: "other-tpl" });

        const res = mockRes();
        const req = mockReq("content-extractor");
        req.params.run_id = "run-uuid-1";
        await new TemplateRunController().get(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe("run_not_found");
    });

    it("refreshes a running crawl run from its legacy job on get", async () => {
        resolveTemplateByRef.mockResolvedValue(crawlTemplate);
        getOwnedTemplateRun.mockResolvedValue({ ...queuedRun, status: "running", legacyJobUuid: "job-9" });
        getJob.mockResolvedValue({ status: "completed", total: 3, completed: 3, failed: 0 });
        finalizeTemplateRun.mockResolvedValue({ ...queuedRun, status: "completed", legacyJobUuid: "job-9" });

        const res = mockRes();
        const req = mockReq("content-extractor");
        req.params.run_id = "run-uuid-1";
        await new TemplateRunController().get(req, res);

        expect(getJob).toHaveBeenCalledWith("job-9");
        expect(finalizeTemplateRun).toHaveBeenCalledWith("run-uuid-1", "completed", expect.anything());
        expect(res.body.data.status).toBe("completed");
    });

    it("cancel is idempotent for a terminal run (returns current state)", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        getOwnedTemplateRun.mockResolvedValue({ ...queuedRun, status: "completed" });

        const res = mockRes();
        const req = mockReq("content-extractor");
        req.params.run_id = "run-uuid-1";
        await new TemplateRunController().cancel(req, res);

        expect(requestTemplateRunCancel).not.toHaveBeenCalled();
        expect(res.body.data.status).toBe("completed");
    });
});
