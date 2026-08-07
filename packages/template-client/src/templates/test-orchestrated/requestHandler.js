// test-orchestrated :: requestHandler (orchestrated page handler)
//
// Readable / node-checkable mirror of
//   test-orchestrated.template.json -> customHandlers.requestHandler.code.source
// The JSON embeds this exact text as an inline string; keep the two in sync
// (regenerate the JSON from this file). The runtime executes this body inside
// the non-trusted VM sandbox as an async function body (top-level `return`
// allowed). Only standard ECMAScript intrinsics plus the sandbox globals
// context / template / variables / JSON / Math / Date / RegExp are available:
// no module loading, no DOM, no cheerio. The page HTML is therefore parsed
// defensively with regex / string scanning only.
//
// Contract (docs/design/template-runs-datasets-platform.md 7.2):
//   returns { items: [Item], nextUrl: string|null, detailRequests: [], warnings: [] }
//
// This minimal template extracts exactly one item per page (title + first
// paragraph) and never paginates — a single page per seed is enough to prove
// the fetch -> extract -> Dataset-write loop; the multi-URL seedHandler proves
// fan-out.

// ---------------------------------------------------------------- helpers ---
const stripTags = (s) => String(s == null ? "" : s).replace(/<[^>]*>/g, " ");
const decodeEntities = (s) =>
    String(s == null ? "" : s)
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, " ");
const cleanText = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();

// Return the first capturing-group value that matches any of the patterns.
const firstMatch = (str, patterns) => {
    let out = null;
    patterns.some((re) => {
        const m = String(str).match(re);
        if (m && m[1] != null && String(m[1]).trim() !== "") {
            out = m[1];
            return true;
        }
        return false;
    });
    return out;
};

// Deterministic itemKey: drop the fragment and any trailing slash so the same
// page always hashes to the same key across runs.
const normalizeUrl = (u) => {
    if (!u) return null;
    let s = String(u).trim();
    const hashIdx = s.indexOf("#");
    if (hashIdx !== -1) s = s.substring(0, hashIdx);
    s = s.replace(/\/+$/, "");
    return s || null;
};

// ------------------------------------------------------------ inputs / ctx ---
const ctx = (typeof context !== "undefined" && context) ? context : {};
const data = ctx.data || {};
const scrape = data.scrapeResult || {};
const html =
    (typeof ctx.html === "string" && ctx.html) ||
    scrape.rawHtml ||
    scrape.html ||
    data.rawHtml ||
    "";
const pageUrl =
    scrape.url || (data.request && data.request.url) || data.url || "";

const run = data.run || {};
const seedKey =
    run.seedKey != null
        ? String(run.seedKey)
        : (data.seedMeta && data.seedMeta.seedKey != null ? String(data.seedMeta.seedKey) : null);
const scrapedAt = new Date().toISOString();

const H = String(html);
const items = [];
const warnings = [];

const normUrl = normalizeUrl(pageUrl) || pageUrl || null;

// title: <title> first, else first <h1>.
const title =
    cleanText(firstMatch(H, [/<title[^>]*>([\s\S]*?)<\/title>/i])) ||
    cleanText(firstMatch(H, [/<h1[^>]*>([\s\S]*?)<\/h1>/i])) ||
    null;

// text: first <p>, tag-stripped + entity-decoded, truncated.
const rawText = firstMatch(H, [/<p[^>]*>([\s\S]*?)<\/p>/i]);
let text = rawText ? cleanText(rawText) : null;
if (text && text.length > 500) text = text.substring(0, 500).trim() + "…";

if (!normUrl) {
    warnings.push({ code: "missing_page_url", message: "no url on scrapeResult" });
} else {
    items.push({
        itemKey: normUrl,
        url: normUrl,
        title: title,
        text: text,
        provenance: { seedKey: seedKey, scrapedAt: scrapedAt },
    });
}

return { items: items, nextUrl: null, detailRequests: [], warnings: warnings };
