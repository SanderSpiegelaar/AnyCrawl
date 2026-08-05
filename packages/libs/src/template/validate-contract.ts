/**
 * Pure, IO-free validators for the L3 template config contract.
 *
 * Implements the publish-time validation rules described in the design doc
 * `docs/design/template-runs-datasets-platform.md`:
 *   - §8  outputSchema (name/version, RFC 6901 pointers, projection types)
 *   - §8  variable extensions (array types, enum, numeric/length constraints)
 *   - §7.2 / §10 orchestrated runtime ("publish fails if orchestrated without seedHandler")
 *
 * These functions never touch the database or perform IO, so they are fully
 * unit-testable. They accept loosely-typed (`unknown`) input on purpose: their
 * job is to validate untrusted authoring input, not to trust the TS types.
 */
import type {
    TemplateProjectionType,
    TemplateVariableScalarType,
} from "../types/template-config.js";
import { TemplateValidationError } from "../types/template-config.js";

/**
 * Consistent validation result. `ok: false` collects every problem found so the
 * caller (publish flow / Dashboard) can surface them all at once.
 */
export type ContractValidationResult = { ok: true } | { ok: false; errors: string[] };

const PROJECTION_TYPES: readonly TemplateProjectionType[] = [
    "string",
    "number",
    "boolean",
    "timestamptz",
];

const SCALAR_VARIABLE_TYPES: readonly TemplateVariableScalarType[] = [
    "string",
    "number",
    "boolean",
    "url",
    "enum",
];

const VARIABLE_TYPES: readonly string[] = [...SCALAR_VARIABLE_TYPES, "array"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;

/**
 * RFC 6901 JSON Pointer check: the empty string, or a string that starts with
 * "/" whose only `~` occurrences are the valid escapes `~0` / `~1`.
 */
export const isJsonPointer = (v: unknown): v is string => {
    if (typeof v !== "string") return false;
    if (v === "") return true;
    if (v[0] !== "/") return false;
    for (let i = 0; i < v.length; i++) {
        if (v[i] === "~") {
            const next = v[i + 1];
            if (next !== "0" && next !== "1") return false;
        }
    }
    return true;
};

const result = (errors: string[]): ContractValidationResult =>
    errors.length === 0 ? { ok: true } : { ok: false, errors };

/**
 * Collect the enum values declared on a definition-like object, from either
 * `enum`, `values`, or `options[].value` (matching the Template Client contract).
 */
const collectEnumValues = (def: Record<string, unknown>): Array<string | number | boolean> | undefined => {
    if (Array.isArray(def.enum)) return def.enum as Array<string | number | boolean>;
    if (Array.isArray(def.values)) return def.values as Array<string | number | boolean>;
    if (Array.isArray(def.options)) {
        return (def.options as Array<Record<string, unknown>>)
            .map((o) => (isPlainObject(o) ? o.value : undefined))
            .filter((v): v is string | number | boolean => v !== undefined);
    }
    return undefined;
};

const matchesScalar = (
    type: TemplateVariableScalarType,
    value: unknown,
    allowed: Array<string | number | boolean> | undefined
): boolean => {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "boolean":
            return typeof value === "boolean";
        case "url":
            if (typeof value !== "string") return false;
            try {
                // eslint-disable-next-line no-new
                new URL(value);
                return true;
            } catch {
                return false;
            }
        case "enum":
            return Array.isArray(allowed) && allowed.includes(value as string | number | boolean);
        default:
            return false;
    }
};

// ---------------------------------------------------------------------------
// validateOutputSchema (doc §8)
// ---------------------------------------------------------------------------

/**
 * Validate a `TemplateConfig.outputSchema`. Errors on: missing/blank name or
 * version, non-pointer `itemsPath` / `itemKeyPath` / `hashExcludePaths`, and
 * malformed projections (missing field, non-pointer path, bad projection type).
 */
export function validateOutputSchema(outputSchema: unknown): ContractValidationResult {
    const errors: string[] = [];

    if (!isPlainObject(outputSchema)) {
        return { ok: false, errors: ["outputSchema must be an object"] };
    }

    if (!isNonEmptyString(outputSchema.name)) {
        errors.push("outputSchema.name is required and must be a non-empty string");
    }
    if (!isNonEmptyString(outputSchema.version)) {
        errors.push("outputSchema.version is required and must be a non-empty string");
    }

    if (outputSchema.itemsPath !== undefined && !isJsonPointer(outputSchema.itemsPath)) {
        errors.push("outputSchema.itemsPath must be an RFC 6901 JSON Pointer (empty or starting with '/')");
    }
    if (outputSchema.itemKeyPath !== undefined && !isJsonPointer(outputSchema.itemKeyPath)) {
        errors.push("outputSchema.itemKeyPath must be an RFC 6901 JSON Pointer (empty or starting with '/')");
    }

    if (outputSchema.hashExcludePaths !== undefined) {
        if (!Array.isArray(outputSchema.hashExcludePaths)) {
            errors.push("outputSchema.hashExcludePaths must be an array of JSON Pointers");
        } else {
            outputSchema.hashExcludePaths.forEach((p, i) => {
                if (!isJsonPointer(p)) {
                    errors.push(`outputSchema.hashExcludePaths[${i}] must be an RFC 6901 JSON Pointer`);
                }
            });
        }
    }

    if (outputSchema.projections !== undefined) {
        if (!Array.isArray(outputSchema.projections)) {
            errors.push("outputSchema.projections must be an array");
        } else {
            outputSchema.projections.forEach((proj, i) => {
                if (!isPlainObject(proj)) {
                    errors.push(`outputSchema.projections[${i}] must be an object`);
                    return;
                }
                if (!isNonEmptyString(proj.field)) {
                    errors.push(`outputSchema.projections[${i}].field is required and must be a non-empty string`);
                }
                if (!isJsonPointer(proj.path)) {
                    errors.push(`outputSchema.projections[${i}].path must be an RFC 6901 JSON Pointer`);
                }
                if (!PROJECTION_TYPES.includes(proj.type as TemplateProjectionType)) {
                    errors.push(
                        `outputSchema.projections[${i}].type must be one of ${PROJECTION_TYPES.join(", ")} (got ${JSON.stringify(proj.type)})`
                    );
                }
            });
        }
    }

    return result(errors);
}

// ---------------------------------------------------------------------------
// validateRuntime (doc §7.2 / §10)
// ---------------------------------------------------------------------------

/**
 * Validate a `TemplateConfig.runtime` block. Orchestrated mode requires a
 * `seedBuilder` handler ("publish fails if orchestrated without seedHandler").
 */
export function validateRuntime(runtime: unknown): ContractValidationResult {
    const errors: string[] = [];

    if (!isPlainObject(runtime)) {
        return { ok: false, errors: ["runtime must be an object"] };
    }

    if (runtime.mode !== "single" && runtime.mode !== "orchestrated") {
        errors.push('runtime.mode must be "single" or "orchestrated"');
    }

    if (runtime.handlerProtocolVersion !== undefined && typeof runtime.handlerProtocolVersion !== "string") {
        errors.push("runtime.handlerProtocolVersion must be a string");
    }

    if (runtime.mode === "orchestrated") {
        const seedBuilder = runtime.seedBuilder;
        if (!isPlainObject(seedBuilder)) {
            errors.push("runtime.seedBuilder is required when runtime.mode is 'orchestrated'");
        } else {
            if (seedBuilder.type !== "handler") {
                errors.push('runtime.seedBuilder.type must be "handler"');
            }
            if (!isNonEmptyString(seedBuilder.name)) {
                errors.push("runtime.seedBuilder.name is required and must be a non-empty string (e.g. 'seedHandler')");
            }
        }
    }

    return result(errors);
}

// ---------------------------------------------------------------------------
// validateVariablesSchema (doc §8)
// ---------------------------------------------------------------------------

const validateEnumOnDef = (
    def: Record<string, unknown>,
    label: string,
    errors: string[]
): Array<string | number | boolean> | undefined => {
    const allowed = collectEnumValues(def);
    if (!Array.isArray(allowed) || allowed.length === 0) {
        errors.push(`${label} enum must declare a non-empty 'enum'/'values'/'options' list`);
        return undefined;
    }
    return allowed;
};

const validateIntConstraint = (value: unknown, label: string, errors: string[]): boolean => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        errors.push(`${label} must be a non-negative integer`);
        return false;
    }
    return true;
};

/**
 * Validate a `TemplateConfig.variables` map. Covers unknown types, enum
 * non-emptiness, array `items` shape, numeric `min <= max`, length
 * `minItems <= maxItems`, and `defaultValue` type matching (including arrays).
 */
export function validateVariablesSchema(variables: unknown): ContractValidationResult {
    // Variables are optional; absence is valid.
    if (variables === undefined || variables === null) {
        return { ok: true };
    }

    if (!isPlainObject(variables)) {
        return { ok: false, errors: ["variables must be an object mapping name -> definition"] };
    }

    const errors: string[] = [];

    for (const [name, rawDef] of Object.entries(variables)) {
        const label = `variable '${name}'`;
        if (!isPlainObject(rawDef)) {
            errors.push(`${label} must be an object`);
            continue;
        }
        const def = rawDef;

        const type = def.type;
        if (typeof type !== "string" || !VARIABLE_TYPES.includes(type)) {
            errors.push(`${label} has invalid type ${JSON.stringify(type)} (expected one of ${VARIABLE_TYPES.join(", ")})`);
            continue;
        }

        if (def.required !== undefined && typeof def.required !== "boolean") {
            errors.push(`${label}.required must be a boolean`);
        }

        // Numeric range constraints (applies to number).
        let minNum: number | undefined;
        let maxNum: number | undefined;
        if (def.min !== undefined) {
            if (typeof def.min !== "number" || !Number.isFinite(def.min)) {
                errors.push(`${label}.min must be a number`);
            } else {
                minNum = def.min;
            }
        }
        if (def.max !== undefined) {
            if (typeof def.max !== "number" || !Number.isFinite(def.max)) {
                errors.push(`${label}.max must be a number`);
            } else {
                maxNum = def.max;
            }
        }
        if (minNum !== undefined && maxNum !== undefined && minNum > maxNum) {
            errors.push(`${label} has min (${minNum}) greater than max (${maxNum})`);
        }

        // Length constraints (applies to array).
        let minItems: number | undefined;
        let maxItems: number | undefined;
        if (def.minItems !== undefined && validateIntConstraint(def.minItems, `${label}.minItems`, errors)) {
            minItems = def.minItems as number;
        }
        if (def.maxItems !== undefined && validateIntConstraint(def.maxItems, `${label}.maxItems`, errors)) {
            maxItems = def.maxItems as number;
        }
        if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
            errors.push(`${label} has minItems (${minItems}) greater than maxItems (${maxItems})`);
        }

        // Per-type structural checks + enum resolution.
        let enumValues: Array<string | number | boolean> | undefined;
        let itemScalarType: TemplateVariableScalarType | undefined;
        let itemEnumValues: Array<string | number | boolean> | undefined;

        if (type === "enum") {
            enumValues = validateEnumOnDef(def, label, errors);
        } else if (type === "array") {
            const items = def.items;
            if (!isPlainObject(items)) {
                errors.push(`${label} is an array and must declare 'items' with an element type`);
            } else if (
                typeof items.type !== "string" ||
                !SCALAR_VARIABLE_TYPES.includes(items.type as TemplateVariableScalarType)
            ) {
                errors.push(
                    `${label}.items.type must be one of ${SCALAR_VARIABLE_TYPES.join(", ")} (got ${JSON.stringify(items.type)})`
                );
            } else {
                itemScalarType = items.type as TemplateVariableScalarType;
                if (itemScalarType === "enum") {
                    itemEnumValues = validateEnumOnDef(items, `${label}.items`, errors);
                }
            }
        }

        // defaultValue type matching.
        if (def.defaultValue !== undefined && def.defaultValue !== null) {
            const dv = def.defaultValue;
            if (type === "array") {
                if (!Array.isArray(dv)) {
                    errors.push(`${label}.defaultValue must be an array`);
                } else {
                    if (minItems !== undefined && dv.length < minItems) {
                        errors.push(`${label}.defaultValue has fewer than minItems (${minItems}) elements`);
                    }
                    if (maxItems !== undefined && dv.length > maxItems) {
                        errors.push(`${label}.defaultValue has more than maxItems (${maxItems}) elements`);
                    }
                    if (itemScalarType !== undefined) {
                        dv.forEach((el, i) => {
                            if (!matchesScalar(itemScalarType!, el, itemEnumValues)) {
                                errors.push(
                                    `${label}.defaultValue[${i}] does not match items.type '${itemScalarType}'`
                                );
                            }
                        });
                    }
                }
            } else {
                if (!matchesScalar(type as TemplateVariableScalarType, dv, enumValues)) {
                    errors.push(`${label}.defaultValue does not match type '${type}'`);
                } else if (type === "number") {
                    if (minNum !== undefined && (dv as number) < minNum) {
                        errors.push(`${label}.defaultValue (${dv}) is less than min (${minNum})`);
                    }
                    if (maxNum !== undefined && (dv as number) > maxNum) {
                        errors.push(`${label}.defaultValue (${dv}) is greater than max (${maxNum})`);
                    }
                }
            }
        }
    }

    return result(errors);
}

// ---------------------------------------------------------------------------
// Combined helper
// ---------------------------------------------------------------------------

/**
 * Validate the L3 contract pieces of a template config (runtime + outputSchema +
 * variables) in one pass, aggregating every error. Pieces that are absent are
 * skipped (they are all optional / additive).
 */
export function validateTemplateContract(config: unknown): ContractValidationResult {
    if (!isPlainObject(config)) {
        return { ok: false, errors: ["template config must be an object"] };
    }

    const errors: string[] = [];

    if (config.runtime !== undefined) {
        const r = validateRuntime(config.runtime);
        if (!r.ok) errors.push(...r.errors);
    }
    if (config.outputSchema !== undefined) {
        const r = validateOutputSchema(config.outputSchema);
        if (!r.ok) errors.push(...r.errors);
    }
    if (config.variables !== undefined) {
        const r = validateVariablesSchema(config.variables);
        if (!r.ok) errors.push(...r.errors);
    }

    return result(errors);
}

/**
 * Throwing convenience wrapper for call sites that prefer exceptions over
 * result objects. Throws {@link TemplateValidationError} with all errors joined.
 */
export function assertValidContractResult(
    res: ContractValidationResult,
    code: string = "TEMPLATE_CONTRACT_VALIDATION_ERROR"
): void {
    if (!res.ok) {
        throw new TemplateValidationError(res.errors.join("; "), code);
    }
}
