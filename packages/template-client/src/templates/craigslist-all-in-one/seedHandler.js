// craigslist-all-in-one :: seedHandler (orchestrated seed builder)
//
// This file is the readable / node-checkable mirror of
//   craigslist-all-in-one.template.json -> customHandlers.seedHandler.code.source
// The JSON embeds this exact text as an inline string; keep the two in sync
// (verified by the template's build/verify step). The runtime executes this
// body inside the non-trusted VM sandbox as an async function body, so it may
// use top-level `return` and the sandbox globals `variables` and `template`.
// Sandbox rules: no module loading, no process access, no DOM APIs. Only
// standard ECMAScript intrinsics plus JSON / Math / Date / RegExp are available.
//
// Contract (docs/design/template-runs-datasets-platform.md 7.2):
//   returns { seeds: [ { seedKey, url, metadata } ], warnings: [] }
// Guided mode expands cities x categories x searchQueries into one seed each
// (empty searchQueries -> one empty-query seed per city x category) rendering
//   https://{host}.craigslist.org/search/{path}?query={query} + filters.
// Advanced URL mode takes a single craigslist search URL -> one seed.

const v = (variables && typeof variables === "object") ? variables : {};
const meta = (template && template.metadata) ? template.metadata : {};
const catalog = (meta && meta.catalog) ? meta.catalog : {};
const cityCatalog = (catalog && catalog.cities) ? catalog.cities : {};
const categoryCatalog = (catalog && catalog.categories) ? catalog.categories : {};

const seeds = [];
const warnings = [];

const enc = (s) => encodeURIComponent(String(s));
const toNum = (x) => {
    if (typeof x === "number" && isFinite(x)) return x;
    if (typeof x === "string" && x.trim() !== "") {
        const n = Number(x.trim());
        if (isFinite(n)) return n;
    }
    return null;
};

// ---- Advanced URL mode (API only, mutually exclusive with guided fields) ----
const advRaw = typeof v.advancedSearchUrl === "string" ? v.advancedSearchUrl.trim() : "";
if (advRaw) {
    const am = advRaw.match(/^https:\/\/([a-z0-9-]+)\.craigslist\.org\/search\/([a-z0-9]+)/i);
    let cityCode = null;
    let categoryCode = null;
    if (am) {
        cityCode = am[1].toLowerCase();
        categoryCode = am[2].toLowerCase();
    }
    const cc = (cityCode && cityCatalog[cityCode]) ? cityCatalog[cityCode] : {};
    const cat = (categoryCode && categoryCatalog[categoryCode]) ? categoryCatalog[categoryCode] : {};
    const known = !!am && !!cityCatalog[cityCode] && !!categoryCatalog[categoryCode];
    if (!known) {
        warnings.push({
            code: "catalog_entry_unknown",
            message: "advanced search url host or category path is not in the template catalog",
            url: advRaw,
        });
    }
    seeds.push({
        seedKey: "adv:" + (cityCode || "unknown") + ":" + (categoryCode || "unknown"),
        url: advRaw,
        metadata: {
            mode: "advanced",
            cityCode: cityCode,
            cityLabel: cc.label || null,
            countryCode: cc.countryCode || null,
            defaultCurrency: cc.defaultCurrency || null,
            categoryCode: categoryCode,
            categoryLabel: cat.label || null,
            categoryFamily: cat.family || null,
            query: null,
            pageIndex: 1,
        },
    });
    return { seeds: seeds, warnings: warnings };
}

// ---- Guided mode: cities x categories x searchQueries ----
const cities = Array.isArray(v.cities) ? v.cities : [];
const categories = Array.isArray(v.categories) ? v.categories : [];
let queries = Array.isArray(v.searchQueries)
    ? v.searchQueries.filter((q) => typeof q === "string")
    : [];
// Empty searchQueries -> exactly one empty-query seed per city x category.
if (queries.length === 0) queries = [""];

const minPrice = toNum(v.minPrice);
const maxPrice = toNum(v.maxPrice);
const hasPic = v.hasPic === true;
const sortVal = v.sort === "date" ? "date" : null; // "default" -> omit (craigslist default)

cities.forEach((cityCode, ci) => {
    const cc = cityCatalog[cityCode] || {};
    const host = cc.host || String(cityCode);
    categories.forEach((categoryCode, gi) => {
        const cat = categoryCatalog[categoryCode] || {};
        const path = cat.searchPath || String(categoryCode);
        const supports = Array.isArray(cat.supportedFilters)
            ? cat.supportedFilters
            : ["query", "minPrice", "maxPrice", "hasPic"];
        queries.forEach((rawQuery, qi) => {
            const query = (rawQuery || "").trim();
            const params = [];
            if (query) params.push("query=" + enc(query));
            if (minPrice !== null && supports.indexOf("minPrice") !== -1) {
                params.push("min_price=" + enc(minPrice));
            }
            if (maxPrice !== null && supports.indexOf("maxPrice") !== -1) {
                params.push("max_price=" + enc(maxPrice));
            }
            if (hasPic && supports.indexOf("hasPic") !== -1) params.push("hasPic=1");
            if (sortVal) params.push("sort=" + sortVal);
            const url =
                "https://" + host + ".craigslist.org/search/" + path +
                (params.length ? "?" + params.join("&") : "");
            const seedKey =
                ci + ":" + gi + ":" + qi + "|" +
                String(cityCode) + ":" + String(categoryCode) + ":" + (query || "*");
            seeds.push({
                seedKey: seedKey,
                url: url,
                metadata: {
                    mode: "guided",
                    cityCode: String(cityCode),
                    cityLabel: cc.label || null,
                    countryCode: cc.countryCode || null,
                    defaultCurrency: cc.defaultCurrency || null,
                    categoryCode: String(categoryCode),
                    categoryLabel: cat.label || null,
                    categoryFamily: cat.family || null,
                    query: query || null,
                    minPrice: minPrice,
                    maxPrice: maxPrice,
                    hasPic: hasPic,
                    sort: sortVal,
                    pageIndex: 1,
                },
            });
        });
    });
});

return { seeds: seeds, warnings: warnings };
