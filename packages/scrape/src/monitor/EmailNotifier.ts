/**
 * Email notifications for monitor change events.
 *
 * Requires ANYCRAWL_SMTP_HOST to be configured. When SMTP is not configured
 * the class is a no-op and logs a warning at first call.
 */
import { config, log } from "@anycrawl/libs";

interface Change {
    url: string;
    changeType: string;
    diffText?: string;
    diffJson?: any[];
    judgment?: { meaningful: boolean; confidence: string; reason: string };
}

export class EmailNotifier {
    /**
     * Send a change digest email to all listed recipients.
     *
     * Delivery contract (callers rely on this — resolving means "delivered to
     * at least one recipient"):
     * - SMTP is not configured → no-op (logged), resolves; callers gate on
     *   config.email.enabled before counting delivery.
     * - nodemailer missing while SMTP IS configured → throws.
     * - Transport-level send failure → the error propagates (rejects).
     * - SMTP server rejects ALL recipients → throws a clear Error.
     * - Partial acceptance → resolves, but rejected addresses are logged as warnings.
     */
    public static async sendChangeEmail(
        recipients: string[],
        monitor: any,
        changes: Change[]
    ): Promise<void> {
        if (!config.email.enabled) {
            log.warning("[MONITOR EMAIL] SMTP not configured — skipping email notification");
            return;
        }
        if (recipients.length === 0) return;

        // Lazy-load nodemailer to avoid requiring it when email is disabled.
        // Must THROW on failure: SMTP is configured, the caller expects delivery,
        // and resolving here would falsely mark changes as notified.
        let nodemailer: any;
        try {
            nodemailer = await import("nodemailer");
        } catch {
            throw new Error(
                "[MONITOR EMAIL] SMTP is configured but nodemailer is not installed — run: pnpm add nodemailer@^9 -F @anycrawl/scrape"
            );
        }

        const transporter = nodemailer.default.createTransport({
            host: config.email.host,
            port: config.email.port,
            secure: config.email.secure,
            auth: config.email.user
                ? { user: config.email.user, pass: config.email.pass }
                : undefined,
        });

        const subject = `[AnyCrawl Monitor] ${monitor.name} — ${changes.length} change${changes.length === 1 ? "" : "s"} detected`;
        const html = buildEmailHtml(monitor, changes);
        const text = buildEmailText(monitor, changes);

        // List-Unsubscribe headers (RFC 2369 / RFC 8058). We only emit the
        // headers — the mailto address / URL must be handled by the operator's
        // mail infrastructure (no unsubscribe endpoint is built in).
        const headers: Record<string, string> = {};
        const unsubscribeTargets: string[] = [];
        if (config.email.unsubscribeAddress) {
            unsubscribeTargets.push(`<mailto:${config.email.unsubscribeAddress}>`);
        }
        if (config.email.unsubscribeUrl) {
            unsubscribeTargets.push(`<${config.email.unsubscribeUrl}>`);
        }
        if (unsubscribeTargets.length > 0) {
            headers["List-Unsubscribe"] = unsubscribeTargets.join(", ");
            // One-click unsubscribe (RFC 8058) is only valid alongside a
            // URL-based List-Unsubscribe target.
            if (config.email.unsubscribeUrl) {
                headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
            }
        }

        // Transport-level failures (connection, auth, ...) propagate to the caller.
        const info = await transporter.sendMail({
            from: config.email.from,
            to: recipients.join(", "),
            subject,
            html,
            text,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });

        const toAddress = (r: any): string =>
            typeof r === "string" ? r : r?.address ?? String(r);
        const accepted: string[] = (info?.accepted ?? []).map(toAddress);
        const rejected: string[] = (info?.rejected ?? []).map(toAddress);

        if (rejected.length > 0 && accepted.length === 0) {
            // Nothing was delivered — surface as an error so callers can record
            // the failure / retry instead of treating the notification as sent.
            throw new Error(
                `SMTP server rejected all recipients (${rejected.join(", ")}) for monitor ${monitor.uuid}`
            );
        }
        if (rejected.length > 0) {
            log.warning(
                `[MONITOR EMAIL] SMTP server rejected ${rejected.length} recipient(s) for monitor ${monitor.uuid}: ${rejected.join(", ")}`
            );
        }

        log.info(`[MONITOR EMAIL] Sent change notification to ${accepted.length || recipients.length}/${recipients.length} recipient(s) for monitor ${monitor.uuid}`);
    }
}

function buildEmailText(monitor: any, changes: Change[]): string {
    const lines: string[] = [
        `Monitor: ${monitor.name} (${monitor.monitorType})`,
        `Changes detected: ${changes.length}`,
        "",
    ];
    for (const c of changes) {
        lines.push(`URL: ${c.url}`);
        lines.push(`Change type: ${c.changeType}`);
        if (c.judgment) {
            lines.push(`AI assessment: ${c.judgment.meaningful ? "meaningful" : "not meaningful"} (${c.judgment.confidence} confidence) — ${c.judgment.reason}`);
        }
        if (c.diffJson && c.diffJson.length > 0) {
            lines.push("Field changes:");
            for (const d of c.diffJson.slice(0, 10)) {
                const delta = d.delta !== undefined ? ` (${d.delta > 0 ? "+" : ""}${d.delta})` : "";
                lines.push(`  ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}${delta}`);
            }
        }
        if (c.diffText) {
            lines.push("Diff (first 500 chars):");
            lines.push(c.diffText.slice(0, 500));
        }
        lines.push("");
    }
    return lines.join("\n");
}

function buildEmailHtml(monitor: any, changes: Change[]): string {
    const rows = changes.map((c) => {
        const diffRows = (c.diffJson ?? []).slice(0, 10).map((d: any) => {
            const delta = d.delta !== undefined ? ` <span style="color:${d.delta > 0 ? "red" : "green"}">(${d.delta > 0 ? "+" : ""}${d.delta})</span>` : "";
            return `<tr><td style="font-family:monospace;padding:2px 8px">${escHtml(d.path)}</td>
                       <td style="padding:2px 8px">${escHtml(JSON.stringify(d.from))}</td>
                       <td style="padding:2px 8px">→</td>
                       <td style="padding:2px 8px">${escHtml(JSON.stringify(d.to))}${delta}</td></tr>`;
        }).join("\n");

        const diffBlock = c.diffText
            ? `<pre style="background:#f5f5f5;padding:8px;overflow:auto;max-height:300px;font-size:12px">${escHtml(c.diffText.slice(0, 2000))}</pre>`
            : "";

        const judgmentBlock = c.judgment
            ? `<p><strong>AI assessment:</strong> ${c.judgment.meaningful ? "✅ Meaningful" : "⚠️ Not meaningful"} (${escHtml(c.judgment.confidence)} confidence) — ${escHtml(c.judgment.reason)}</p>`
            : "";

        return `<div style="border:1px solid #ddd;border-radius:4px;padding:12px;margin-bottom:16px">
            <h3 style="margin:0 0 8px">${escHtml(c.url)}</h3>
            <p><strong>Change type:</strong> <code>${escHtml(c.changeType)}</code></p>
            ${judgmentBlock}
            ${diffRows ? `<table style="border-collapse:collapse;width:100%"><tr><th style="text-align:left;padding:2px 8px">Field</th><th>From</th><th></th><th>To</th></tr>${diffRows}</table>` : ""}
            ${diffBlock}
        </div>`;
    }).join("\n");

    return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:800px;margin:auto;padding:24px">
        <h2>🔔 AnyCrawl Monitor — ${escHtml(monitor.name)}</h2>
        <p><strong>Type:</strong> ${escHtml(monitor.monitorType)} &nbsp; <strong>Changes:</strong> ${changes.length}</p>
        ${rows}
        <hr><p style="color:#888;font-size:12px">AnyCrawl Monitor — manage at your dashboard</p>
    </body></html>`;
}

function escHtml(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
