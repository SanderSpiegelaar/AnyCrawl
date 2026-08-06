import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { ALLOWED_ENGINES } from "../constants.js";
import { jsonSchemaType } from "./BaseSchema.js";

// Fastest allowed monitor cadence. Matches the dashboard's fastest preset; a
// floor also caps per-check billing/scrape load from direct API callers.
const MIN_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const cronField = z
    .string()
    .superRefine((val, ctx) => {
        // cron-parser also accepts 6-field (seconds) expressions; monitors are
        // documented as standard 5-field and must not fire sub-minute.
        if (val.trim().split(/\s+/).length !== 5) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "cron_expression must be a standard 5-field cron expression",
            });
            return;
        }
        let interval;
        try {
            interval = CronExpressionParser.parse(val);
        } catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cron expression" });
            return;
        }
        // Enforce the interval floor across several successive fires — a single
        // gap sample misses expressions with mixed cadences (e.g. "0,1 */6 * * *").
        try {
            let prev = interval.next().getTime();
            for (let i = 0; i < 4; i++) {
                const next = interval.next().getTime();
                if (next - prev < MIN_CHECK_INTERVAL_MS) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "cron_expression must not fire more often than every 15 minutes",
                    });
                    return;
                }
                prev = next;
            }
        } catch {
            // Fewer than 5 future fires is fine (cron is effectively unbounded;
            // parse errors were handled above).
        }
    });

const timezoneField = z.string().refine(
    (tz) => {
        try {
            // Throws on invalid IANA names; an invalid timezone would otherwise be
            // stored and silently produce a monitor that never runs (next-execution
            // computation fails and BullMQ rejects the repeatable registration).
            new Intl.DateTimeFormat("en", { timeZone: tz });
            return true;
        } catch {
            return false;
        }
    },
    "Invalid IANA timezone (e.g. 'UTC', 'Asia/Singapore', 'America/New_York')"
);

/**
 * Hostname-only check for private/reserved/internal addresses (SSRF guard).
 *
 * Covers: localhost / *.localhost / *.local / *.internal, IPv4 literals in
 * 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 and 0/8, and IPv6 literals
 * that are loopback (::1), link-local (fe80::/10) or unique-local (fc00::/7),
 * including IPv4-mapped forms (::ffff:a.b.c.d).
 *
 * Duplicates the spirit of the private-IP guard in
 * packages/scrape/src/managers/Webhook.ts (isPrivateIP) — kept separate
 * because @anycrawl/libs must not depend on @anycrawl/scrape.
 *
 * LIMITATION: this is a syntactic, hostname-only check with NO DNS resolution
 * (zod validation is synchronous). A public hostname that resolves to a
 * private address (DNS rebinding) is not caught here; that requires
 * resolve-time enforcement in the fetch layer.
 */
export function isPrivateOrInternalHostname(hostname: string): boolean {
    // Lowercase, strip a trailing dot (FQDN form) and IPv6 URL brackets.
    const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");

    // Local/internal hostnames
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host.endsWith(".local") || host.endsWith(".internal")) return true;

    // IPv4 literal in private/reserved ranges
    const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const parts = v4.slice(1).map(Number);
        if (parts.some((p) => p > 255)) return false; // not a valid IPv4 literal
        const [a, b] = parts as [number, number, number, number];
        if (a === 0) return true; // 0.0.0.0/8 ("this network")
        if (a === 10) return true; // 10.0.0.0/8
        if (a === 127) return true; // 127.0.0.0/8 (loopback)
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true; // 192.168.0.0/16
        if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
        return false;
    }

    // IPv6 literal
    if (host.includes(":")) {
        if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true; // loopback
        if (/^fe[89ab]/.test(host)) return true; // fe80::/10 (link-local)
        if (/^f[cd]/.test(host)) return true; // fc00::/7 (unique-local)
        // IPv4-mapped IPv6 — re-check the embedded IPv4. Dotted form
        // (::ffff:10.0.0.1) appears in raw input; the WHATWG URL parser
        // normalizes it to hex groups (::ffff:a00:1), so handle both.
        const mappedDotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (mappedDotted) return isPrivateOrInternalHostname(mappedDotted[1]!);
        const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1]!, 16);
            const lo = parseInt(mappedHex[2]!, 16);
            return isPrivateOrInternalHostname(
                `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
            );
        }
        return false;
    }

    return false;
}

// A single monitored target. Underlying scrape options are passed through verbatim.
export const monitorTargetSchema = z.object({
    url: z
        .string()
        .url()
        .superRefine((val, ctx) => {
            // SSRF guard for hosted deployments: monitor targets are scheduled,
            // repeated fetches whose bodies are readable via the snapshots API,
            // so private-network URLs are an exfiltration channel. Env-gated and
            // OFF by default — self-host users legitimately monitor internal
            // services. The env var is read here, at VALIDATION time (not module
            // load), so deployments/tests can toggle it after import.
            if (process.env.ANYCRAWL_BLOCK_PRIVATE_TARGETS !== "true") return;
            let hostname: string;
            try {
                hostname = new URL(val).hostname;
            } catch {
                return; // unparseable URLs are already rejected by .url()
            }
            if (isPrivateOrInternalHostname(hostname)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        "url must not target a private, loopback, or internal address",
                });
            }
        }),
    engine: z.enum(ALLOWED_ENGINES).default("auto"),
    options: z.object({}).passthrough().optional(),
    location: z.object({ country: z.string() }).optional(),
});

// Upper bounds guard against resource abuse (email fan-out, per-run selector work).
const MAX_TARGETS = 50;
const MAX_EMAIL_RECIPIENTS = 20;
const MAX_IGNORE_SELECTORS = 50;
const MAX_TAGS = 20;

export const createMonitorSchema = z
    .object({
        name: z.string().min(1).max(255),
        description: z.string().nullable().optional(),
        // 'webpage' = text change detection; 'price' = structured field extraction + diff
        monitor_type: z.enum(["webpage", "price"]).default("webpage"),
        cron_expression: cronField,
        timezone: timezoneField.default("UTC"),
        targets: z.array(monitorTargetSchema).min(1).max(MAX_TARGETS),
        // Natural-language criterion for the AI judge (optional)
        goal: z.string().optional(),
        // Defaults are inferred from monitor_type when omitted (see transform below)
        track_mode: z.enum(["text", "json", "mixed"]).optional(),
        // Required for price monitors (enforced by superRefine)
        extract_schema: jsonSchemaType.optional(),
        diff_options: z
            .object({
                ignore_selectors: z.array(z.string()).max(MAX_IGNORE_SELECTORS).optional(),
                only_main_content: z.boolean().optional(),
                min_change_ratio: z.number().min(0).max(1).optional(),
            })
            .optional(),
        notify_options: z
            .object({
                channels: z.array(z.enum(["webhook", "email"])).default(["webhook"]),
                email_recipients: z.array(z.string().email()).max(MAX_EMAIL_RECIPIENTS).optional(),
                only_meaningful: z.boolean().default(true),
                thresholds: z
                    .object({
                        price_change_pct: z.number().optional(),
                    })
                    .optional(),
            })
            .optional(),
        concurrency_mode: z.enum(["skip", "queue"]).default("skip"),
        max_executions_per_day: z.number().int().positive().nullable().optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        metadata: z.record(z.any()).optional(),
    })
    .superRefine((data, ctx) => {
        if (data.monitor_type === "price" && !data.extract_schema) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["extract_schema"],
                message: "extract_schema is required when monitor_type is 'price'",
            });
        }
        if (
            data.notify_options?.channels?.includes("email") &&
            (!data.notify_options.email_recipients || data.notify_options.email_recipients.length === 0)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["notify_options", "email_recipients"],
                message: "email_recipients is required when 'email' is in notify channels",
            });
        }
    });

export const updateMonitorSchema = z
    .object({
        name: z.string().min(1).max(255).optional(),
        description: z.string().nullable().optional(),
        cron_expression: cronField.optional(),
        timezone: timezoneField.optional(),
        targets: z.array(monitorTargetSchema).min(1).max(MAX_TARGETS).optional(),
        goal: z.string().nullable().optional(),
        track_mode: z.enum(["text", "json", "mixed"]).optional(),
        extract_schema: jsonSchemaType.optional(),
        diff_options: z
            .object({
                ignore_selectors: z.array(z.string()).max(MAX_IGNORE_SELECTORS).optional(),
                only_main_content: z.boolean().optional(),
                min_change_ratio: z.number().min(0).max(1).optional(),
            })
            .optional(),
        notify_options: z
            .object({
                channels: z.array(z.enum(["webhook", "email"])).optional(),
                email_recipients: z.array(z.string().email()).max(MAX_EMAIL_RECIPIENTS).optional(),
                only_meaningful: z.boolean().optional(),
                thresholds: z
                    .object({
                        price_change_pct: z.number().optional(),
                    })
                    .optional(),
            })
            .optional(),
        concurrency_mode: z.enum(["skip", "queue"]).optional(),
        max_executions_per_day: z.number().int().positive().nullable().optional(),
        is_active: z.boolean().optional(),
        tags: z.array(z.string()).max(MAX_TAGS).optional(),
        metadata: z.record(z.any()).optional(),
    })
    .superRefine((data, ctx) => {
        // NOTE: switching track_mode to json/mixed without a usable extract_schema is
        // rejected by the controller's merge-time check (MonitorController.update),
        // which can see the schema already stored on the row — this schema cannot.
        // If email is being enabled in this update, recipients must be provided in the same update.
        if (
            data.notify_options?.channels?.includes("email") &&
            (!data.notify_options.email_recipients || data.notify_options.email_recipients.length === 0)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["notify_options", "email_recipients"],
                message: "email_recipients is required when 'email' is in notify channels",
            });
        }
    });

/**
 * Resolve the effective track_mode: explicit value wins, otherwise inferred from monitor_type.
 * price -> json, webpage -> text.
 */
export function resolveTrackMode(
    monitorType: "webpage" | "price",
    trackMode?: "text" | "json" | "mixed"
): "text" | "json" | "mixed" {
    if (trackMode) return trackMode;
    return monitorType === "price" ? "json" : "text";
}

export type MonitorTargetInput = z.infer<typeof monitorTargetSchema>;
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
