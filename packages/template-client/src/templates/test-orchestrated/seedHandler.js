// test-orchestrated :: seedHandler (orchestrated seed builder)
//
// This file is the readable / node-checkable mirror of
//   test-orchestrated.template.json -> customHandlers.seedHandler.code.source
// The JSON embeds this exact text as an inline string; keep the two in sync
// (regenerate the JSON from this file). The runtime executes this body inside
// the non-trusted VM sandbox as an async function body, so it may use top-level
// `return` and the sandbox globals `variables` and `template`. Sandbox rules:
// no module loading, no process access, no DOM APIs. Only standard ECMAScript
// intrinsics plus JSON / Math / Date / RegExp are available.
//
// Contract (docs/design/template-runs-datasets-platform.md 7.2):
//   returns { seeds: [ { seedKey, url, metadata } ], warnings: [] }
//
// This minimal template fans a single `urls` array variable out into one seed
// per URL (seedKey = the array index) so an orchestrated run can prove both
// seed expansion and multi-seed fan-out against reliably reachable pages.

const v = (variables && typeof variables === "object") ? variables : {};
const rawUrls = Array.isArray(v.urls) ? v.urls : [];

const seeds = [];
const warnings = [];

rawUrls.forEach((entry, i) => {
    const url = typeof entry === "string" ? entry.trim() : "";
    if (!url) {
        warnings.push({
            code: "invalid_url",
            message: "urls[" + i + "] is not a non-empty string",
        });
        return;
    }
    seeds.push({
        seedKey: String(i),
        url: url,
        metadata: {
            seedKey: String(i),
            index: i,
            sourceUrl: url,
        },
    });
});

return { seeds: seeds, warnings: warnings };
