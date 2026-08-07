import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Billing } from "@anycrawl/db";
import { RequestWithAuth } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";
import { deductCreditsMiddleware } from "../middlewares/DeductCreditsMiddleware.js";

interface MockedRequest extends Partial<RequestWithAuth> {
    method: string;
    path: string;
    route?: { path?: string };
    jobId?: string;
    creditsUsed?: number;
    checkCredits?: boolean;
}

interface MockedResponse {
    statusCode: number;
    on: (event: string, listener: () => void) => MockedResponse;
}

function createMockResponse(statusCode: number): {
    res: MockedResponse;
    emit: (event: string) => void;
} {
    const listeners = new Map<string, () => void>();
    const res: MockedResponse = {
        statusCode,
        on: (event: string, listener: () => void) => {
            listeners.set(event, listener);
            return res;
        },
    };

    return {
        res,
        emit: (event: string) => {
            const handler = listeners.get(event);
            if (handler) {
                handler();
            }
        },
    };
}

async function waitFor(assertion: () => void, timeoutMs = 7000): Promise<void> {
    const started = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - started < timeoutMs) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    throw lastError || new Error("waitFor timeout");
}

describe("DeductCreditsMiddleware billing behavior", () => {
    const originalAuthEnabled = process.env.ANYCRAWL_API_AUTH_ENABLED;
    const originalCreditsEnabled = process.env.ANYCRAWL_API_CREDITS_ENABLED;
    const originalNodeEnv = process.env.NODE_ENV;

    beforeAll(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = "true";
        process.env.ANYCRAWL_API_CREDITS_ENABLED = "true";
    });

    beforeEach(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = "true";
        process.env.ANYCRAWL_API_CREDITS_ENABLED = "true";
    });

    afterEach(() => {
        jest.restoreAllMocks();
        process.env.NODE_ENV = originalNodeEnv;
    });

    afterAll(() => {
        process.env.ANYCRAWL_API_AUTH_ENABLED = originalAuthEnabled;
        process.env.ANYCRAWL_API_CREDITS_ENABLED = originalCreditsEnabled;
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("uses target mode and retries without extra charging on transient failures", async () => {
        const chargeDetails = {
            version: 1 as const,
            basis: "charged_delta" as const,
            calculator: "scrape_v1",
            total: 7,
            items: [
                { code: "base_scrape", credits: 1 },
                { code: "json_llm_extract", credits: 6 },
            ],
        };
        const targetSpy = jest
            .spyOn(Billing, "chargeToUsedByJobId")
            .mockRejectedValueOnce(new Error("transient-1"))
            .mockRejectedValueOnce(new Error("transient-2"))
            .mockResolvedValue({
                jobId: "job-target-retry",
                charged: 7,
                currentUsed: 7,
                remainingCredits: 93,
            });
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/scrape",
            route: { path: "/v1/scrape" },
            jobId: "job-target-retry",
            creditsUsed: 7,
            checkCredits: true,
            billingChargeDetails: chargeDetails,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(targetSpy).toHaveBeenCalledTimes(3);
        }, 9000);

        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).toHaveBeenCalledWith({
            jobId: "job-target-retry",
            targetUsed: 7,
            reason: "api_request_finalize",
            idempotencyKey: "api:request-finalize:job-target-retry:7",
            chargeDetails,
        });
    }, 15000);

    it("uses delta mode for crawl creation route, including trailing slash", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "job-crawl-initial",
            charged: 3,
            currentUsed: 3,
            remainingCredits: 97,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/crawl/",
            route: { path: "/v1/crawl" },
            jobId: "job-crawl-initial",
            creditsUsed: 3,
            checkCredits: true,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await waitFor(() => {
            expect(deltaSpy).toHaveBeenCalledTimes(1);
        });
        expect(targetSpy).not.toHaveBeenCalled();
        expect(deltaSpy).toHaveBeenCalledWith({
            jobId: "job-crawl-initial",
            delta: 3,
            reason: "api_crawl_initial",
            idempotencyKey: "api:crawl-initial:job-crawl-initial",
        });
    });

    it("skips deduction when jobId is missing", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/search",
            route: { path: "/v1/search" },
            creditsUsed: 5,
            checkCredits: true,
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).not.toHaveBeenCalled();
    });

    it("skips deduction for non-success response", async () => {
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/map",
            route: { path: "/v1/map" },
            jobId: "job-failed",
            creditsUsed: 11,
            checkCredits: true,
        } as MockedRequest;
        const { res, emit } = createMockResponse(500);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        emit("finish");
        expect(next).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).not.toHaveBeenCalled();
    });

    it("throws the billing invariant in non-production when a chargeable request skipped the credit gate", async () => {
        process.env.NODE_ENV = "test";
        const errorSpy = jest.spyOn(log, "error").mockImplementation(() => { });
        const deltaSpy = jest.spyOn(Billing, "chargeDeltaByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "unused",
            charged: 0,
            currentUsed: 0,
            remainingCredits: 0,
        });

        const req = {
            method: "POST",
            path: "/v1/scrape",
            route: { path: "/v1/scrape" },
            jobId: "job-ungated",
            creditsUsed: 5,
            // checkCredits intentionally omitted: simulates a route missing checkCreditsMiddleware
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        expect(next).toHaveBeenCalledTimes(1);

        expect(() => emit("finish")).toThrow(/\[BILLING-INVARIANT\]/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[BILLING-INVARIANT]"));

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(deltaSpy).not.toHaveBeenCalled();
        expect(targetSpy).not.toHaveBeenCalled();
    });

    it("stays log-only (does not throw) in production when a chargeable request skipped the credit gate", async () => {
        process.env.NODE_ENV = "production";
        const errorSpy = jest.spyOn(log, "error").mockImplementation(() => { });
        const targetSpy = jest.spyOn(Billing, "chargeToUsedByJobId").mockResolvedValue({
            jobId: "job-ungated-prod",
            charged: 5,
            currentUsed: 5,
            remainingCredits: 95,
        });

        const req = {
            method: "POST",
            path: "/v1/scrape",
            route: { path: "/v1/scrape" },
            jobId: "job-ungated-prod",
            creditsUsed: 5,
            // checkCredits intentionally omitted: simulates a route missing checkCreditsMiddleware
        } as MockedRequest;
        const { res, emit } = createMockResponse(200);
        const next = jest.fn();

        await deductCreditsMiddleware(req as RequestWithAuth, res as unknown as any, next);
        expect(next).toHaveBeenCalledTimes(1);

        expect(() => emit("finish")).not.toThrow();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[BILLING-INVARIANT]"));

        // Fail-closed: still deducts credits in production despite the missing gate.
        await waitFor(() => {
            expect(targetSpy).toHaveBeenCalledTimes(1);
        });
    });
});
