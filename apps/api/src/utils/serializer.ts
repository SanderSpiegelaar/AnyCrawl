/**
 * Response serialization utilities
 * Converts database query results (camelCase) to API responses (snake_case)
 */

/**
 * Convert a camelCase string to snake_case
 */
function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Convert an object's TOP-LEVEL keys from camelCase to snake_case.
 *
 * Deliberately shallow: only column names are ours to rename. Nested values are
 * JSONB payloads whose keys belong to the user (extract_schema properties,
 * extracted data, metadata, task payloads) — recursing into them corrupted
 * user-defined keys (e.g. an extract field `salePrice` became `sale_price`,
 * `Price` became `_price`) and the mangled shape round-tripped back into the DB
 * on the next dashboard save. JSONB written by our own API handlers is already
 * snake_case at rest, so it needs no conversion here either.
 */
export function toSnakeCase<T = any>(obj: any): T {
    if (obj === null || obj === undefined) {
        return obj;
    }

    // Arrays of records (list responses)
    if (Array.isArray(obj)) {
        return obj.map((item) => toSnakeCase(item)) as any;
    }

    // Dates and primitives pass through
    if (typeof obj !== "object" || obj instanceof Date) {
        return obj as any;
    }

    const result: any = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            result[camelToSnake(key)] = obj[key];
        }
    }

    return result;
}

/**
 * Serialize a single database record to snake_case API response
 */
export function serializeRecord<T = any>(record: any): T {
    return toSnakeCase<T>(record);
}

/**
 * Serialize an array of database records to snake_case API responses
 */
export function serializeRecords<T = any>(records: any[]): T[] {
    return records.map((record) => toSnakeCase<T>(record));
}
