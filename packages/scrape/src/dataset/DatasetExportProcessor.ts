import { log, s3 } from "@anycrawl/libs";
import { getDB, getDataset, getDatasetItems, updateDatasetExportStatus } from "@anycrawl/db";
import type { DatasetExportJobPayload } from "../managers/Queue.js";

/** One declared queryable-field projection, as snapshotted onto datasets.query_fields. */
interface QueryField {
    field: string;
    path: string;
    type: "string" | "number" | "boolean" | "timestamptz";
}

/**
 * Worker for the `dataset-export` queue: renders a Dataset's items to JSONL or
 * CSV and uploads the file to storage (platform §11 exports / master-plan
 * §3.2). Mirrors OrchestratedRunner's try/catch discipline — every error path
 * is caught here and persisted as a `failed` export status; nothing escapes
 * `run()` uncaught.
 */
export class DatasetExportProcessor {
    async run(payload: DatasetExportJobPayload): Promise<void> {
        const { exportId, datasetId, format } = payload;
        try {
            const db = await getDB();
            await updateDatasetExportStatus(db, exportId, { status: "running" });

            // Read-only, no owner scoping needed here — the controller already
            // validated ownership of `datasetId` when the export was created.
            const dataset = await getDataset(db, datasetId);
            const queryFields: QueryField[] = Array.isArray(dataset?.queryFields)
                ? (dataset!.queryFields as QueryField[])
                : [];

            // Page through all dataset items in batches of 500, accumulating in
            // memory until nextCursor is null.
            // NOTE: this buffers the full export in memory — acceptable for the
            // current expected dataset sizes; a genuinely large-dataset
            // streaming-to-S3-multipart path is out of scope for this pass.
            const items: any[] = [];
            let cursor: any = null;
            for (; ;) {
                const page = await getDatasetItems(db, { datasetId, limit: 500, cursor });
                items.push(...page.items);
                if (!page.nextCursor) break;
                cursor = page.nextCursor;
            }

            const body = format === "csv" ? this.toCsv(items, queryFields) : this.toJsonl(items);
            const fileKey = `dataset-exports/${datasetId}/${exportId}.${format}`;
            await s3.upload(fileKey, body);

            await updateDatasetExportStatus(db, exportId, {
                status: "completed",
                itemCount: items.length,
                fileKey,
                completedAt: new Date(),
            });
            log.info(`[dataset-export] [${exportId}] completed: ${items.length} items -> ${fileKey}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`[dataset-export] [${exportId}] failed: ${message}`);
            try {
                const db = await getDB();
                await updateDatasetExportStatus(db, exportId, {
                    status: "failed",
                    error: message,
                    completedAt: new Date(),
                });
            } catch (persistError) {
                log.error(`[dataset-export] [${exportId}] failed to persist failure status: ${persistError}`);
            }
        }
    }

    /** One JSON object per line: platform columns + the item's document fields. */
    private toJsonl(items: any[]): string {
        return items
            .map((item) =>
                JSON.stringify({
                    item_key: item.itemKey,
                    source_url: item.sourceUrl ?? null,
                    last_seen_at: this.formatTimestamp(item.lastSeenAt),
                    is_active: !!item.isActive,
                    ...(item.document ?? {}),
                })
            )
            .join("\n");
    }

    /**
     * RFC-4180-ish CSV: header = platform columns + the dataset's declared
     * query_fields projections only. Arbitrary nested `document` JSON is
     * deliberately NOT flattened into ragged columns — users who need the full
     * document should use JSONL.
     */
    private toCsv(items: any[], queryFields: QueryField[]): string {
        const headers = ["item_key", "source_url", "last_seen_at", "is_active", ...queryFields.map((f) => f.field)];
        const lines = [headers.map((h) => this.csvCell(h)).join(",")];
        for (const item of items) {
            const row: unknown[] = [
                item.itemKey,
                item.sourceUrl ?? "",
                this.formatTimestamp(item.lastSeenAt),
                !!item.isActive,
            ];
            for (const f of queryFields) {
                row.push(this.getPath(item.document, f.path));
            }
            lines.push(row.map((cell) => this.csvCell(cell)).join(","));
        }
        return lines.join("\r\n");
    }

    private formatTimestamp(value: unknown): string {
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "number") return new Date(value).toISOString();
        return value ? String(value) : "";
    }

    /** Quote a cell if it contains a comma, double quote, or newline; double up internal quotes. */
    private csvCell(value: unknown): string {
        if (value === null || value === undefined) return "";
        const s = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (/[",\n\r]/.test(s)) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    }

    /**
     * Resolve an RFC 6901 JSON pointer ("/a/b" or the shorthand "a") against the
     * item document. Mirrors DatasetWriter.getPath (kept local — small enough
     * not to warrant a cross-package export).
     */
    private getPath(source: unknown, path: string): unknown {
        const segments = String(path)
            .split("/")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
        let node: any = source;
        for (const seg of segments) {
            if (node === null || typeof node !== "object") return undefined;
            node = node[seg];
        }
        return node;
    }
}
