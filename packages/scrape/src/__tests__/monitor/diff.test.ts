import { textDiff, priceDiff, classifyPriceChange } from "../../monitor/diff.js";

describe("monitor/diff", () => {
    describe("textDiff", () => {
        test("identical content reports no change", () => {
            const r = textDiff("line a\nline b", "line a\nline b");
            expect(r.changed).toBe(false);
            expect(r.ratio).toBe(0);
            expect(r.diffText).toBe("");
        });

        test("changed content reports a diff with ratio > 0", () => {
            const r = textDiff("price: $19\nplan: pro", "price: $24\nplan: pro");
            expect(r.changed).toBe(true);
            expect(r.ratio).toBeGreaterThan(0);
            expect(r.diffText).toContain("-price: $19");
            expect(r.diffText).toContain("+price: $24");
        });

        test("added lines appear as additions", () => {
            const r = textDiff("a\nb", "a\nb\nc");
            expect(r.changed).toBe(true);
            expect(r.diffText).toContain("+c");
        });

        test("common prefix/suffix trimming yields the standard unified diff", () => {
            // A localized change with plenty of identical surrounding lines:
            // trimming must not alter the rendered hunk (header, ±3 context).
            const prev = ["ctx1", "ctx2", "ctx3", "ctx4", "old line", "tail1", "tail2", "tail3", "tail4"].join("\n");
            const next = ["ctx1", "ctx2", "ctx3", "ctx4", "new line", "tail1", "tail2", "tail3", "tail4"].join("\n");
            const r = textDiff(prev, next);
            expect(r.changed).toBe(true);
            expect(r.diffText).toBe(
                [
                    "@@ -2,7 +2,7 @@",
                    " ctx2",
                    " ctx3",
                    " ctx4",
                    "-old line",
                    "+new line",
                    " tail1",
                    " tail2",
                    " tail3",
                ].join("\n")
            );
            expect(r.ratio).toBeCloseTo(1 / 9);
        });

        test("huge input with a localized change avoids the LCS blowup and diffs precisely", () => {
            // 20001 lines per side: without prefix/suffix trimming the LCS
            // table would be ~4e8 cells. With trimming the middle is 1 line.
            const common = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
            const prev = [...common.slice(0, 10000), "OLD", ...common.slice(10000)].join("\n");
            const next = [...common.slice(0, 10000), "NEW", ...common.slice(10000)].join("\n");
            const r = textDiff(prev, next);
            expect(r.changed).toBe(true);
            expect(r.diffText).toContain("-OLD");
            expect(r.diffText).toContain("+NEW");
            expect(r.diffText).not.toContain("diff truncated");
        });

        test("falls back to a truncated summary diff when the differing region exceeds the cap", () => {
            // Every line differs → nothing trims → 6000-line middle > 5000 cap.
            const prev = Array.from({ length: 6000 }, (_, i) => `item ${i} price ${i}`).join("\n");
            const next = Array.from({ length: 6000 }, (_, i) => `item ${i} price ${i + 1}`).join("\n");
            const r = textDiff(prev, next);
            expect(r.changed).toBe(true);
            expect(r.diffText).toContain("... diff truncated (6000/6000 lines compared)");
            expect(r.diffText).toContain("-item 0 price 0");
            expect(r.diffText).toContain("+item 0 price 1");
            // Capped output: far fewer lines than the full 12000-line diff.
            expect(r.diffText.split("\n").length).toBeLessThan(200);
            expect(r.ratio).toBe(1);
        });

        test("summary fallback covers one-sided growth (added lines beyond the cap)", () => {
            const prev = "only line";
            const next = Array.from({ length: 6001 }, (_, i) => `new ${i}`).join("\n");
            const r = textDiff(prev, next);
            expect(r.changed).toBe(true);
            expect(r.diffText).toContain("diff truncated");
            expect(r.diffText).toContain("-only line");
            expect(r.diffText).toContain("+new 0");
        });
    });

    describe("priceDiff", () => {
        test("no diff for identical objects", () => {
            const diffs = priceDiff({ price: 19, currency: "USD" }, { price: 19, currency: "USD" });
            expect(diffs).toHaveLength(0);
        });

        test("numeric change carries delta", () => {
            const diffs = priceDiff({ price: 19 }, { price: 24 });
            expect(diffs).toHaveLength(1);
            expect(diffs[0]).toMatchObject({ path: "price", from: 19, to: 24, delta: 5 });
        });

        test("nested array path extraction", () => {
            const prev = { plans: [{ name: "pro", price: 19 }] };
            const next = { plans: [{ name: "pro", price: 24 }] };
            const diffs = priceDiff(prev, next);
            expect(diffs).toHaveLength(1);
            expect(diffs[0]!.path).toBe("plans[0].price");
            expect(diffs[0]!.delta).toBe(5);
        });

        test("added array element", () => {
            const prev = { plans: [{ name: "pro" }] };
            const next = { plans: [{ name: "pro" }, { name: "enterprise" }] };
            const diffs = priceDiff(prev, next);
            expect(diffs.some((d) => d.path.startsWith("plans[1]"))).toBe(true);
        });

        test("mismatched shapes (object vs array) do not throw and produce diffs", () => {
            // Extractor shape drift: previous run returned an object, this run
            // an array. priceDiff falls into the plain-object branch (array
            // indices become keys) — noisy but safe.
            expect(() => priceDiff({ price: 19 }, [{ price: 19 }])).not.toThrow();
            const diffs = priceDiff({ price: 19 }, [{ price: 19 }]);
            expect(Array.isArray(diffs)).toBe(true);
            expect(diffs.length).toBeGreaterThan(0);
        });

        test("nested array-vs-object drift does not throw", () => {
            expect(() =>
                priceDiff({ plans: [{ price: 1 }] }, { plans: { pro: { price: 2 } } })
            ).not.toThrow();
            const diffs = priceDiff({ plans: [{ price: 1 }] }, { plans: { pro: { price: 2 } } });
            expect(Array.isArray(diffs)).toBe(true);
        });
    });

    describe("classifyPriceChange", () => {
        test("classifies a price increase as price_up", () => {
            const diffs = [{ path: "plans[0].price", from: 19, to: 24, delta: 5 }];
            expect(classifyPriceChange(diffs)).toBe("price_up");
        });

        test("classifies a price decrease as price_down", () => {
            const diffs = [{ path: "price", from: 24, to: 19, delta: -5 }];
            expect(classifyPriceChange(diffs)).toBe("price_down");
        });

        test("respects price_change_pct threshold", () => {
            // 19 -> 19.10 is ~0.5% change, below a 1% threshold — suppressed
            // entirely per the documented threshold semantics (no alert at all,
            // not a downgrade to "content").
            const diffs = [{ path: "price", from: 19, to: 19.1, delta: 0.1 }];
            expect(classifyPriceChange(diffs, { price_change_pct: 1 })).toBe(null);
        });

        test("sub-threshold price move mixed with other diffs still classifies as content", () => {
            const diffs = [
                { path: "price", from: 19, to: 19.1, delta: 0.1 },
                { path: "title", from: "Basic", to: "Basic Plan" },
            ];
            expect(classifyPriceChange(diffs, { price_change_pct: 1 })).toBe("content");
        });

        test("stock field change classified as stock", () => {
            const diffs = [{ path: "in_stock", from: true, to: false }];
            expect(classifyPriceChange(diffs)).toBe("stock");
        });

        test("no diffs returns null", () => {
            expect(classifyPriceChange([])).toBeNull();
        });
    });
});
