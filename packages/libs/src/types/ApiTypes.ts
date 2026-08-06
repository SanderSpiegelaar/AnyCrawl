import { Request } from "express";
import type { BillingChargeDetailsV1 } from "./BillingChargeDetails.js";

export interface RequestWithAuth extends Request {
    auth?: {
        uuid: string;
        user?: string;
        key: string;
        name: string;
        isActive: boolean;
        createdBy: number;
        hashedKey: string;
        salt: string;
        credits: number;
        createdAt: Date;
        lastUsedAt?: Date;
        expiresAt?: Date;
    };
    creditsUsed?: number;
    billingChargeDetails?: BillingChargeDetailsV1;
    checkCredits?: boolean;
    jobId?: string;
    // Set by the template dedicated-endpoint dispatcher before delegating, so downstream
    // billing (delta vs target) knows the real action without sniffing req.path.
    resolvedTemplateType?: "scrape" | "crawl" | "search";
}
