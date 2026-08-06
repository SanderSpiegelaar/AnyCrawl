import { Response, NextFunction } from "express";
import { RequestWithAuth, appConfig } from "@anycrawl/libs";
import { log } from "@anycrawl/libs/log";
import { getDB, schemas, eq } from "@anycrawl/db";

/**
 * Coarse credit pre-flight gate.
 *
 * Attach this as ROUTE-LEVEL middleware on every billing route (fail-closed): a route that can
 * create a chargeable job must declare `checkCreditsMiddleware` at its definition, so new billing
 * endpoints (e.g. /template/:ref/execute) cannot silently bypass the balance check. This replaces
 * the old app-level mount + central path allowlist, which was fail-open — any unlisted billing
 * path executed for free.
 *
 * The gate is action-agnostic: it only verifies `balance > 0`. The real amount is metered per job
 * by DeductCreditsMiddleware, which also enforces a fail-closed invariant (chargeable request must
 * have passed this gate).
 */
export const checkCreditsMiddleware = async (
    req: RequestWithAuth,
    res: Response,
    next: NextFunction
): Promise<void> => {
    if (!appConfig.authEnabled || !appConfig.creditsEnabled) {
        next();
        return;
    }

    req.checkCredits = true;

    try {
        const userUuid = req.auth?.uuid;
        if (!req.auth) {
            res.status(401).json({
                success: false,
                error: "Authentication required",
            });
            return;
        }

        // Get current credits from database in real-time
        const db = await getDB();
        const [user] = await db
            .select({ credits: schemas.apiKey.credits })
            .from(schemas.apiKey)
            .where(eq(schemas.apiKey.uuid, userUuid));

        if (!user) {
            res.status(404).json({
                success: false,
                error: "User not found",
            });
            return;
        }

        // Update auth object with latest credits
        if (req.auth) {
            req.auth.credits = user.credits;
        }

        // Check if user has any credits (allowing negative credits now)
        if (user.credits <= 0) {
            res.status(402).json({
                success: false,
                error: "Insufficient credits",
                current_credits: user.credits,
            });
            return;
        }

        next();
    } catch (error) {
        log.error(`Error checking credits: ${error}`);
        res.status(500).json({
            success: false,
            error: "Internal server error",
        });
        return;
    }
};
