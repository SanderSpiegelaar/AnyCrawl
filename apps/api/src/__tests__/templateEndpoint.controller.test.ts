import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Shared spies for the delegated controllers (each mocked class instance shares these).
const scrapeHandle = jest.fn(async () => { });
const searchHandle = jest.fn(async () => { });
const crawlStart = jest.fn(async () => { });
const resolveTemplateByRef = jest.fn<(ref: string) => Promise<any>>();
const hasTemplateAccess = jest.fn<(template: any, userId?: string) => boolean>();

jest.unstable_mockModule("@anycrawl/db", () => ({ resolveTemplateByRef }));
jest.unstable_mockModule("../utils/templateHandler.js", () => ({
    TemplateHandler: { hasTemplateAccess },
}));
jest.unstable_mockModule("../controllers/v1/ScrapeController.js", () => ({
    ScrapeController: class {
        handle = scrapeHandle;
    },
}));
jest.unstable_mockModule("../controllers/v1/SearchController.js", () => ({
    SearchController: class {
        handle = searchHandle;
    },
}));
jest.unstable_mockModule("../controllers/v1/CrawlController.js", () => ({
    CrawlController: class {
        start = crawlStart;
    },
}));

const { TemplateEndpointController } = await import(
    "../controllers/v1/TemplateEndpointController.js"
);

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

function mockReq(templateRef: string, body: any = {}): any {
    return { params: { templateRef }, body, auth: { user: "user-1" } };
}

const scrapeTemplate = {
    templateId: "content-extractor",
    slug: "content-extractor",
    templateType: "scrape",
    name: "Content Extractor",
    description: "d",
    version: "1.0.0",
    variables: { foo: { type: "string" } },
    pricing: { perCall: 1, currency: "credits" },
    metadata: { allowedDomains: { type: "glob", patterns: ["*"] } },
};

describe("TemplateEndpointController.execute", () => {
    beforeEach(() => {
        hasTemplateAccess.mockReturnValue(true);
    });

    it("returns 404 when the template ref cannot be resolved", async () => {
        resolveTemplateByRef.mockResolvedValue(null);
        const controller = new TemplateEndpointController();
        const req = mockReq("unknown");
        const res = mockRes();

        await controller.execute(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body.data.type).toBe("TEMPLATE_NOT_FOUND");
        expect(scrapeHandle).not.toHaveBeenCalled();
    });

    it("returns 403 when the user lacks access", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        hasTemplateAccess.mockReturnValue(false);
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor");
        const res = mockRes();

        await controller.execute(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body.data.type).toBe("ACCESS_DENIED");
        expect(scrapeHandle).not.toHaveBeenCalled();
    });

    it("returns 400 when body template_id conflicts with the resolved template", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor", { template_id: "something-else" });
        const res = mockRes();

        await controller.execute(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.data.type).toBe("VALIDATION_ERROR");
        expect(scrapeHandle).not.toHaveBeenCalled();
    });

    it("dispatches scrape templates to ScrapeController.handle, injecting template_id + resolvedTemplateType", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor", { url: "https://example.com" });
        const res = mockRes();

        await controller.execute(req, res);

        expect(scrapeHandle).toHaveBeenCalledTimes(1);
        expect(req.body.template_id).toBe("content-extractor");
        expect(req.resolvedTemplateType).toBe("scrape");
    });

    it("dispatches search templates to SearchController.handle", async () => {
        resolveTemplateByRef.mockResolvedValue({ ...scrapeTemplate, templateType: "search" });
        const controller = new TemplateEndpointController();
        const req = mockReq("news-search", { query: "hello" });
        const res = mockRes();

        await controller.execute(req, res);

        expect(searchHandle).toHaveBeenCalledTimes(1);
        expect(req.resolvedTemplateType).toBe("search");
    });

    it("dispatches crawl templates to CrawlController.start (delta billing signal)", async () => {
        resolveTemplateByRef.mockResolvedValue({ ...scrapeTemplate, templateType: "crawl" });
        const controller = new TemplateEndpointController();
        const req = mockReq("site-crawler", { url: "https://example.com" });
        const res = mockRes();

        await controller.execute(req, res);

        expect(crawlStart).toHaveBeenCalledTimes(1);
        expect(req.resolvedTemplateType).toBe("crawl");
    });

    it("resolves by templateId when addressed without a slug", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor", { url: "https://example.com" });
        const res = mockRes();

        await controller.execute(req, res);

        expect(resolveTemplateByRef).toHaveBeenCalledWith("content-extractor");
        expect(scrapeHandle).toHaveBeenCalledTimes(1);
    });
});

describe("TemplateEndpointController.spec", () => {
    beforeEach(() => {
        hasTemplateAccess.mockReturnValue(true);
    });

    it("returns a redacted call-spec with the slug-based endpoint path", async () => {
        resolveTemplateByRef.mockResolvedValue(scrapeTemplate);
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor");
        const res = mockRes();

        await controller.spec(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data.endpoint.path).toBe("/v1/template/content-extractor/execute");
        expect(res.body.data.template_type).toBe("scrape");
        expect(res.body.data.variables).toEqual({ foo: { type: "string" } });
        // never leak reqOptions / handlers
        expect(res.body.data.reqOptions).toBeUndefined();
        expect(res.body.data.customHandlers).toBeUndefined();
    });

    it("falls back to templateId in the endpoint path when no slug is set", async () => {
        resolveTemplateByRef.mockResolvedValue({ ...scrapeTemplate, slug: null });
        const controller = new TemplateEndpointController();
        const req = mockReq("content-extractor");
        const res = mockRes();

        await controller.spec(req, res);

        expect(res.body.data.slug).toBeNull();
        expect(res.body.data.endpoint.path).toBe("/v1/template/content-extractor/execute");
    });
});
