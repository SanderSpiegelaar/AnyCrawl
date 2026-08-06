/**
 * Lightweight diff utilities for web-change and price monitoring.
 *
 * We intentionally avoid adding an npm dependency for the text diff — the
 * line-level implementation below is sufficient for change-detection and
 * human-readable notification payloads at MVP scale.
 */

// ---------------------------------------------------------------------------
// Text diff (web change monitoring)
// ---------------------------------------------------------------------------

export interface TextDiffResult {
    changed: boolean;
    diffText: string;
    /** Fraction of lines that differ (0 = identical, 1 = completely different) */
    ratio: number;
}

/**
 * Max lines (per side, after common prefix/suffix trimming) fed into the
 * O(m×n) LCS table. 2000² × 8B ≈ 32MB transient — a 5000 cap would still admit
 * ~200MB allocations inside the worker. Beyond this we fall back to a cheap
 * positional summary diff.
 */
const MAX_LCS_LINES = 2000;

/** Max differing lines rendered in the fallback summary diff. */
const MAX_SUMMARY_DIFF_LINES = 50;

/**
 * Produce a unified-diff-style text summary comparing two normalized content
 * strings. Context lines (unchanged) are included up to ±3 lines.
 */
export function textDiff(prev: string, next: string): TextDiffResult {
    if (prev === next) return { changed: false, diffText: "", ratio: 0 };

    const prevLines = prev.split("\n");
    const nextLines = next.split("\n");
    const totalLines = Math.max(prevLines.length, nextLines.length, 1);

    // Trim common prefix/suffix lines before the LCS: identical lines add
    // nothing to the diff (context lines are re-read from the full arrays at
    // render time), and trimming keeps the O(m×n) table small for large
    // snapshots that only changed locally.
    const minLen = Math.min(prevLines.length, nextLines.length);
    let trimStart = 0;
    while (trimStart < minLen && prevLines[trimStart] === nextLines[trimStart]) {
        trimStart++;
    }
    let trimEnd = 0;
    while (
        trimEnd < minLen - trimStart &&
        prevLines[prevLines.length - 1 - trimEnd] === nextLines[nextLines.length - 1 - trimEnd]
    ) {
        trimEnd++;
    }
    const prevMid = prevLines.slice(trimStart, prevLines.length - trimEnd);
    const nextMid = nextLines.slice(trimStart, nextLines.length - trimEnd);

    // Guard against the O(m×n) memory blowup: when the differing region is
    // still huge, emit a truncated positional summary instead of a full LCS.
    if (prevMid.length > MAX_LCS_LINES || nextMid.length > MAX_LCS_LINES) {
        return summaryDiff(prevMid, nextMid, trimStart, totalLines);
    }

    // Simple LCS-based line diff over the trimmed middle; shift hunk indices
    // back so rendering uses original line numbers and full-array context.
    const hunks = computeLineDiff(prevMid, nextMid);
    for (const h of hunks) {
        h.prevStart += trimStart;
        h.nextStart += trimStart;
    }
    const diffText = renderUnifiedDiff(hunks, prevLines, nextLines);

    const changedLines = hunks.reduce(
        (acc, h) => acc + Math.max(h.delCount, h.addCount),
        0
    );
    const ratio = Math.min(changedLines / totalLines, 1);

    return { changed: true, diffText, ratio };
}

/**
 * Cheap fallback diff for oversized inputs: positional line comparison of the
 * (already prefix/suffix-trimmed) middle regions, rendered as a truncated
 * unified-style hunk. Never allocates more than O(m+n).
 */
function summaryDiff(
    prevMid: string[],
    nextMid: string[],
    trimStart: number,
    totalLines: number
): TextDiffResult {
    const lines: string[] = [];
    // Unified convention: an empty a-side uses the line BEFORE the insertion
    // point (`-N,0`), not one past it.
    const aStart = prevMid.length === 0 ? trimStart : trimStart + 1;
    const bStart = nextMid.length === 0 ? trimStart : trimStart + 1;
    lines.push(`@@ -${aStart},${prevMid.length} +${bStart},${nextMid.length} @@`);

    const pairLen = Math.min(prevMid.length, nextMid.length);
    let differing = 0;
    let shown = 0;
    for (let i = 0; i < pairLen; i++) {
        if (prevMid[i] !== nextMid[i]) {
            differing++;
            if (shown < MAX_SUMMARY_DIFF_LINES) {
                lines.push(`-${prevMid[i]}`);
                lines.push(`+${nextMid[i]}`);
                shown++;
            }
        }
    }
    for (let i = pairLen; i < prevMid.length; i++) {
        differing++;
        if (shown < MAX_SUMMARY_DIFF_LINES) {
            lines.push(`-${prevMid[i]}`);
            shown++;
        }
    }
    for (let i = pairLen; i < nextMid.length; i++) {
        differing++;
        if (shown < MAX_SUMMARY_DIFF_LINES) {
            lines.push(`+${nextMid[i]}`);
            shown++;
        }
    }
    lines.push(`... diff truncated (${prevMid.length}/${nextMid.length} lines compared)`);

    const ratio = Math.min(Math.max(differing, 1) / totalLines, 1);
    return { changed: true, diffText: lines.join("\n"), ratio };
}

// --- LCS helpers ---

interface Hunk {
    /** 0-indexed start line in prevLines */
    prevStart: number;
    delCount: number;
    /** 0-indexed start line in nextLines */
    nextStart: number;
    addCount: number;
}

function computeLineDiff(prev: string[], next: string[]): Hunk[] {
    // Myers-diff over line arrays — O(ND) approximate via DP edit distance
    const m = prev.length;
    const n = next.length;

    // Build edit-distance table
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
        new Array(n + 1).fill(0)
    );
    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i]![j] =
                prev[i - 1] === next[j - 1]
                    ? dp[i - 1]![j - 1]!
                    : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
        }
    }

    // Backtrack to find the edit operations
    type Op = { type: "keep" | "del" | "add"; prevIdx: number; nextIdx: number };
    const ops: Op[] = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && prev[i - 1] === next[j - 1]) {
            ops.push({ type: "keep", prevIdx: i - 1, nextIdx: j - 1 });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i]![j - 1]! <= dp[i - 1]![j]!)) {
            ops.push({ type: "add", prevIdx: i, nextIdx: j - 1 });
            j--;
        } else {
            ops.push({ type: "del", prevIdx: i - 1, nextIdx: j });
            i--;
        }
    }
    ops.reverse();

    // Collapse consecutive del/add into hunks
    const hunks: Hunk[] = [];
    let k = 0;
    while (k < ops.length) {
        const op = ops[k]!;
        if (op.type === "keep") {
            k++;
            continue;
        }
        const hunk: Hunk = {
            prevStart: op.prevIdx,
            delCount: 0,
            nextStart: op.nextIdx,
            addCount: 0,
        };
        while (k < ops.length && ops[k]!.type !== "keep") {
            if (ops[k]!.type === "del") hunk.delCount++;
            else hunk.addCount++;
            k++;
        }
        hunks.push(hunk);
    }
    return hunks;
}

const CONTEXT = 3;

function renderUnifiedDiff(hunks: Hunk[], prev: string[], next: string[]): string {
    if (hunks.length === 0) return "";
    const lines: string[] = [];

    for (const hunk of hunks) {
        const ctxStart = Math.max(0, hunk.prevStart - CONTEXT);
        const ctxEnd = Math.min(prev.length, hunk.prevStart + hunk.delCount + CONTEXT);

        const aStart = ctxStart + 1;
        const aLen = ctxEnd - ctxStart;
        const bStart = hunk.nextStart - (hunk.prevStart - ctxStart) + 1;
        const bLen = aLen - hunk.delCount + hunk.addCount;

        lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);

        for (let p = ctxStart; p < hunk.prevStart; p++) {
            lines.push(` ${prev[p]}`);
        }
        for (let p = hunk.prevStart; p < hunk.prevStart + hunk.delCount; p++) {
            lines.push(`-${prev[p]}`);
        }
        for (let n = hunk.nextStart; n < hunk.nextStart + hunk.addCount; n++) {
            lines.push(`+${next[n]}`);
        }
        for (let p = hunk.prevStart + hunk.delCount; p < ctxEnd; p++) {
            lines.push(` ${prev[p]}`);
        }
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON / price diff (price monitoring)
// ---------------------------------------------------------------------------

export interface FieldDiff {
    path: string;
    from: any;
    to: any;
    delta?: number;
}

/**
 * Recursively compare two extracted JSON objects and return a flat list of
 * changed fields with their before/after values.
 * Arrays are compared element-by-element by index.
 */
export function priceDiff(prev: any, next: any, path = ""): FieldDiff[] {
    if (prev === null && next === null) return [];
    if (typeof prev !== typeof next || (prev === null) !== (next === null)) {
        return [buildDiff(path || "root", prev, next)];
    }
    if (typeof prev !== "object" || prev === null) {
        return prev === next ? [] : [buildDiff(path || "root", prev, next)];
    }
    if (Array.isArray(prev) && Array.isArray(next)) {
        const diffs: FieldDiff[] = [];
        const len = Math.max(prev.length, next.length);
        for (let i = 0; i < len; i++) {
            const p = `${path}[${i}]`;
            if (i >= prev.length) {
                diffs.push(buildDiff(p, undefined, next[i]));
            } else if (i >= next.length) {
                diffs.push(buildDiff(p, prev[i], undefined));
            } else {
                diffs.push(...priceDiff(prev[i], next[i], p));
            }
        }
        return diffs;
    }
    // Plain object
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const diffs: FieldDiff[] = [];
    for (const key of keys) {
        const p = path ? `${path}.${key}` : key;
        diffs.push(...priceDiff(prev[key], next[key], p));
    }
    return diffs;
}

function buildDiff(path: string, from: any, to: any): FieldDiff {
    const diff: FieldDiff = { path, from, to };
    if (typeof from === "number" && typeof to === "number") {
        diff.delta = to - from;
    }
    return diff;
}

// ---------------------------------------------------------------------------
// Price change classification
// ---------------------------------------------------------------------------

export type PriceChangeType =
    | "price_up"
    | "price_down"
    | "stock"
    | "content"
    | null;

export interface PriceThresholds {
    price_change_pct?: number;
}

/**
 * Inspect field diffs and classify the most significant price change.
 * Returns null if no price-relevant fields changed above any configured threshold.
 */
export function classifyPriceChange(
    diffs: FieldDiff[],
    thresholds: PriceThresholds = {}
): PriceChangeType {
    const PRICE_PATH_RE = /price|cost|amount|rate/i;
    const STOCK_PATH_RE = /stock|inventory|available|quantity/i;
    const minPct = thresholds.price_change_pct ?? 0;

    let hasPriceUp = false;
    let hasPriceDown = false;
    let hasStock = false;
    let subThresholdCount = 0;

    for (const d of diffs) {
        if (STOCK_PATH_RE.test(d.path)) {
            hasStock = true;
            continue;
        }
        if (PRICE_PATH_RE.test(d.path) && typeof d.from === "number" && typeof d.to === "number") {
            const pct = d.from !== 0 ? Math.abs((d.to - d.from) / d.from) * 100 : 100;
            if (pct >= minPct) {
                if (d.delta !== undefined && d.delta > 0) hasPriceUp = true;
                else if (d.delta !== undefined && d.delta < 0) hasPriceDown = true;
            } else {
                subThresholdCount++;
            }
        }
    }

    if (hasPriceUp) return "price_up";
    if (hasPriceDown) return "price_down";
    if (hasStock) return "stock";
    // Every diff is a price move below thresholds.price_change_pct — suppress the
    // alert entirely rather than downgrading it to a "content" change, which is
    // what the threshold is documented to do ("低于该阈值不触发价格告警").
    if (minPct > 0 && subThresholdCount === diffs.length) return null;
    if (diffs.length > 0) return "content";
    return null;
}
