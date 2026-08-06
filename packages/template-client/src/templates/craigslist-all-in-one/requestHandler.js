// craigslist-all-in-one :: requestHandler (orchestrated page handler)
//
// Readable / node-checkable mirror of
//   craigslist-all-in-one.template.json -> customHandlers.requestHandler.code.source
// The JSON embeds this exact text as an inline string; keep the two in sync
// (verified by the template's build/verify step). The runtime executes this
// body inside the non-trusted VM sandbox as an async function body (top-level
// `return` allowed). Only standard ECMAScript intrinsics plus the sandbox
// globals context / template / variables / JSON / Math / Date / RegExp are
// available: no module loading, no DOM, no cheerio. Craigslist search-results
// HTML is therefore parsed defensively with regex/string scanning.
//
// Contract (docs/design/template-runs-datasets-platform.md 7.2):
//   returns { items: [ListingSummary], nextUrl: string|null, detailRequests: [], warnings: [] }
// Phase 1: search listing scraper only. No detail requests.

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

const numberify = (x, fallback) => {
    const n = Number(x);
    return isFinite(n) ? n : fallback;
};

// Craigslist price / currency parser (design doc section 11).
const parsePrice = (raw, country) => {
    if (raw == null || String(raw).trim() === "") {
        return { raw: null, amount: null, currency: null, parsed: false, isRange: false, isFree: false };
    }
    const t = String(raw).trim();
    let currency = null;
    if (/C\$|\bCAD\b/i.test(t)) currency = "CAD";
    else if (/US\$|\bUSD\b/i.test(t)) currency = "USD";
    else if (t.indexOf("$") !== -1) currency = country === "US" ? "USD" : country === "CA" ? "CAD" : null;
    const nums = t.match(/[0-9][0-9.,]*/g) || [];
    const isFree = /\bfree\b/i.test(t);
    const isRange = nums.length > 1;
    let amount = null;
    if (!isFree && !isRange && nums.length === 1) {
        const n = Number(nums[0].replace(/,/g, ""));
        if (isFinite(n)) amount = n;
    }
    return { raw: t, amount: amount, currency: currency, parsed: amount !== null, isRange: isRange, isFree: isFree };
};

const normalizeUrl = (href, origin) => {
    if (!href) return null;
    let u = decodeEntities(String(href)).trim();
    if (u.indexOf("//") === 0) return "https:" + u;
    if (u.charAt(0) === "/") return origin ? origin + u : null;
    if (/^https?:\/\//i.test(u)) return u;
    return null;
};

// ------------------------------------------------------------ inputs / ctx ---
const ctx = (typeof context !== "undefined" && context) ? context : {};
const data = ctx.data || {};
const scrape = data.scrapeResult || {};
const html = (typeof ctx.html === "string" && ctx.html) || scrape.rawHtml || scrape.html || data.rawHtml || "";
const pageUrl =
    scrape.url || (data.request && data.request.url) || data.url || (data.metadata && data.metadata.url) || "";

const tmpl = ctx.template || (typeof template !== "undefined" ? template : {}) || {};
const catalog = (tmpl.metadata && tmpl.metadata.catalog) ? tmpl.metadata.catalog : {};
const cityCatalog = catalog.cities || {};
const categoryCatalog = catalog.categories || {};

const seedMeta =
    data.seedMeta ||
    (data.userData && (data.userData.seedMeta || data.userData.seed || data.userData.metadata)) ||
    data.metadata ||
    {};

const urlHost = ((pageUrl.match(/^https?:\/\/([a-z0-9-]+)\.craigslist\.org/i) || [])[1] || "").toLowerCase() || null;
const urlCat = ((pageUrl.match(/\/search\/([a-z0-9]+)/i) || [])[1] || "").toLowerCase() || null;

const cityCode = seedMeta.cityCode || urlHost || null;
const categoryCode = seedMeta.categoryCode || urlCat || null;
const cityEntry = (cityCode && cityCatalog[cityCode]) ? cityCatalog[cityCode] : {};
const catEntry = (categoryCode && categoryCatalog[categoryCode]) ? categoryCatalog[categoryCode] : {};
const countryCode = seedMeta.countryCode || cityEntry.countryCode || null;
const categoryLabel = seedMeta.categoryLabel || catEntry.label || null;
const categoryFamily = seedMeta.categoryFamily || catEntry.family || null;
const seedKey = seedMeta.seedKey || null;
const pageIndex = numberify(
    seedMeta.pageIndex || data.pageIndex || (data.userData && data.userData.pageIndex) || 1,
    1
);
const scrapedAt = new Date().toISOString();
const origin =
    (pageUrl.match(/^(https?:\/\/[^/]+)/) || [])[1] ||
    (urlHost ? "https://" + urlHost + ".craigslist.org" : "");

// ------------------------------------------------------- listing extraction ---
const items = [];
const warnings = [];
const H = String(html);

// One candidate per detail link (.../<digits>.html). Dedup by id, keep first.
const linkRe = /href="((?:https?:)?\/\/[a-z0-9.-]+\.craigslist\.org\/[^"?#]*?\/(\d{6,})\.html)"/gi;
const seen = {};
const cards = [];
[...H.matchAll(linkRe)].forEach((m) => {
    const id = m[2];
    if (seen[id]) return;
    seen[id] = true;
    let url = m[1];
    if (url.indexOf("//") === 0) url = "https:" + url;
    cards.push({ id: id, url: url, index: m.index });
});

const titlePatterns = [
    /class="[^"]*posting-title[^"]*"[^>]*>\s*([\s\S]*?)<\/a>/i,
    /class="[^"]*result-title[^"]*"[^>]*>\s*([\s\S]*?)<\/a>/i,
    /class="[^"]*hdrlnk[^"]*"[^>]*>\s*([\s\S]*?)<\/a>/i,
    /class="[^"]*title[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|a|span|h[1-6])>/i,
    /<li[^>]+title="([^"]+)"/i,
    />\s*([^<]{2,140})\s*<\/a>/i,
];
const pricePatterns = [
    /class="[^"]*priceinfo[^"]*"[^>]*>\s*([^<]*)</i,
    /class="[^"]*result-price[^"]*"[^>]*>\s*([^<]*)</i,
    /class="[^"]*price[^"]*"[^>]*>\s*([^<]*)</i,
];
const locPatterns = [
    /class="[^"]*result-hood[^"]*"[^>]*>\s*([^<]*)</i,
    /class="[^"]*location[^"]*"[^>]*>\s*([^<]*)</i,
    /class="[^"]*supertitle[^"]*"[^>]*>\s*([^<]*)</i,
];
const datePatterns = [/datetime="([^"]+)"/i];
const imgSrcPatterns = [/<img[^>]+src="([^"]+)"/i, /data-ids="[0-9]+:([0-9a-z]+)/i];
const hasImageRe = /data-ids="[^"]+"|<img\b|result-image|gallery-card|swipe/i;

cards.forEach((card, i) => {
    // Scope each listing to its enclosing <li>...</li> so fields do not bleed
    // between cards and the next card's opening tag is excluded.
    let start = H.lastIndexOf("<li ", card.index);
    if (start < 0) start = card.index > 300 ? card.index - 300 : 0;
    let end = H.indexOf("</li>", card.index);
    if (end < 0) end = i + 1 < cards.length ? cards[i + 1].index : H.length;
    else end += 5;
    const slice = H.substring(start, end);
    const position = i + 1;

    const title = cleanText(firstMatch(slice, titlePatterns)) || null;

    // Required contract: id + url + title. Skip half-baked rows (doc section 9).
    if (!card.id || !card.url || !title) {
        warnings.push({
            code: "invalid_listing",
            pageIndex: pageIndex,
            position: position,
            id: card.id || null,
            url: card.url || null,
            reason: "missing required listing field id url or title",
        });
        return;
    }

    const rawPrice = cleanText(firstMatch(slice, pricePatterns)) || null;
    const price = parsePrice(rawPrice, countryCode);

    const rawLoc = firstMatch(slice, locPatterns);
    const location = rawLoc
        ? decodeEntities(stripTags(rawLoc)).replace(/[()]/g, "").replace(/\s+/g, " ").trim() || null
        : null;

    const postedAt = firstMatch(slice, datePatterns) || null;

    const hasImage = hasImageRe.test(slice);
    let thumbnailUrl = null;
    if (hasImage) {
        const imgHit = firstMatch(slice, imgSrcPatterns);
        if (imgHit && /^https?:|^\/\//i.test(imgHit)) thumbnailUrl = normalizeUrl(imgHit, origin);
        else if (imgHit) thumbnailUrl = "https://images.craigslist.org/" + imgHit + "_300x300.jpg";
    }

    // Deterministic completeness (doc section 12).
    const applicable = [card.id, card.url, title, categoryCode, price.raw, location, postedAt];
    let present = 0;
    let total = 0;
    applicable.forEach((f) => {
        total += 1;
        if (f !== null && f !== undefined && f !== "") present += 1;
    });
    total += 1; // hasImage is always a valid boolean (false counts as present)
    present += 1;
    if (hasImage === true) {
        total += 1;
        if (thumbnailUrl) present += 1;
    }
    const completeness = Math.round((present / total) * 100);

    const missingFields = [];
    if (categoryCode == null) missingFields.push("category.code");
    if (price.raw == null) missingFields.push("price.raw");
    if (location == null) missingFields.push("location.raw");
    if (postedAt == null) missingFields.push("postedAt");
    if (hasImage === true && thumbnailUrl == null) missingFields.push("thumbnailUrl");

    const itemWarnings = [];
    if (price.raw == null) itemWarnings.push("price_missing");
    else if (!price.parsed && !price.isRange && !price.isFree) itemWarnings.push("price_parse_uncertain");
    if (location == null) itemWarnings.push("location_missing");
    if (postedAt == null) itemWarnings.push("posted_time_missing");
    if (hasImage === true && thumbnailUrl == null) itemWarnings.push("thumbnail_missing");

    items.push({
        id: card.id,
        itemKey: "craigslist:" + card.id,
        source: "craigslist",
        url: card.url,
        title: title,
        price: { raw: price.raw, amount: price.amount, currency: price.currency },
        location: { raw: location, cityCode: cityCode, countryCode: countryCode },
        category: { code: categoryCode, label: categoryLabel, family: categoryFamily },
        postedAt: postedAt,
        thumbnailUrl: thumbnailUrl,
        hasImage: hasImage,
        pageIndex: pageIndex,
        position: position,
        quality: {
            completeness: completeness,
            status: completeness === 100 ? "complete" : "partial",
            missingFields: missingFields,
            warnings: itemWarnings,
        },
        provenance: { seedKey: seedKey, scrapedAt: scrapedAt },
    });
});

// ----------------------------------------------------------------- nextUrl ---
const nextPatterns = [
    /<link[^>]+rel="next"[^>]+href="([^"]+)"/i,
    /rel="next"[^>]*href="([^"]+)"/i,
    /href="([^"]+)"[^>]*rel="next"/i,
    /class="[^"]*button[^"]*next[^"]*"[^>]*href="([^"]+)"/i,
    /href="([^"]+)"[^>]*class="[^"]*button[^"]*next[^"]*"/i,
];
let nextUrl = normalizeUrl(firstMatch(html, nextPatterns), origin);
if (nextUrl && pageUrl && nextUrl === pageUrl) nextUrl = null; // loop guard

return { items: items, nextUrl: nextUrl, detailRequests: [], warnings: warnings };
