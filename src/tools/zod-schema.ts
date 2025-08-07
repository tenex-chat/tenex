/**
 * Zod-based schema system for TENEX tools
 */

import { z } from "zod";
import type { ParameterSchema, SchemaShape, Validated, ValidationError, Result } from "./core";

// MCP schema type definitions
interface MCPPropertyDefinition {
    type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
    description?: string;
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    items?: MCPPropertyDefinition;
    properties?: Record<string, MCPPropertyDefinition>;
    required?: string[];
    minItems?: number;
    maxItems?: number;
}

interface MCPSchema {
    properties?: Record<string, MCPPropertyDefinition>;
    required?: string[];
}

/**
 * Convert a Zod schema to our SchemaShape format
 */
function zodToSchemaShape(schema: z.ZodType<unknown>, isOptional = false): SchemaShape {
    if (schema instanceof z.ZodOptional) {
        const optionalDef = schema._def as z.ZodOptionalDef;
        return zodToSchemaShape(optionalDef.innerType, true);
    }

    // Handle undefined/null/void schemas
    if (
        schema instanceof z.ZodUndefined ||
        schema instanceof z.ZodNull ||
        schema instanceof z.ZodVoid
    ) {
        return {
            type: "object",
            description: "No parameters required",
            properties: {},
            required: [],
        };
    }

    // Handle union schemas (like z.undefined().or(z.null()))
    if (schema instanceof z.ZodUnion) {
        // If it's a union of undefined/null/void, treat it as no parameters
        const unionDef = schema._def as z.ZodUnionDef;
        const options = Array.from(unionDef.options) as z.ZodType<unknown>[];
        const allVoid = options.every(
            (opt) =>
                opt instanceof z.ZodUndefined ||
                opt instanceof z.ZodNull ||
                opt instanceof z.ZodVoid
        );
        if (allVoid) {
            return {
                type: "object",
                description: "No parameters required",
                properties: {},
                required: [],
            };
        }
        // Otherwise, use the first option
        const firstOption = options[0];
        if (!firstOption) {
            throw new Error("Union type must have at least one option");
        }
        return zodToSchemaShape(firstOption, isOptional);
    }

    if (schema instanceof z.ZodString) {
        // For enum values, we need to check if it's a ZodEnum
        if (schema instanceof z.ZodEnum) {
            const enumSchema = schema as z.ZodEnum<[string, ...string[]]>;
            return {
                type: "string",
                description: schema.description || "String parameter",
                enum: enumSchema.options,
                required: !isOptional,
            };
        }
        return {
            type: "string",
            description: schema.description || "String parameter",
            required: !isOptional,
        };
    }
    if (schema instanceof z.ZodNumber) {
        // Get min/max from the schema definition more safely
        const def = schema._def as z.ZodNumberDef;
        let min: number | undefined;
        let max: number | undefined;

        if (def.checks) {
            for (const check of def.checks) {
                if (check.kind === "min") {
                    min = check.value;
                } else if (check.kind === "max") {
                    max = check.value;
                }
            }
        }

        return {
            type: "number",
            description: schema.description || "Number parameter",
            min,
            max,
            required: !isOptional,
        };
    }
    if (schema instanceof z.ZodBoolean) {
        return {
            type: "boolean",
            description: schema.description || "Boolean parameter",
            required: !isOptional,
        };
    }
    if (schema instanceof z.ZodArray) {
        const arrayDef = schema._def as z.ZodArrayDef;
        return {
            type: "array",
            description: schema.description || "Array parameter",
            items: zodToSchemaShape(arrayDef.type),
            required: !isOptional,
        };
    }
    if (schema instanceof z.ZodObject) {
        const properties: Record<string, SchemaShape> = {};
        const objectDef = schema._def as z.ZodObjectDef;
        const shape = objectDef.shape();
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
            const propShape = zodToSchemaShape(value as z.ZodType<unknown>);
            properties[key] = propShape;
            if (propShape.required !== false) {
                required.push(key);
            }
        }
        return {
            type: "object",
            description: schema.description || "Object parameter",
            properties,
            required,
        };
    }
    // Fallback for unknown types
    return {
        type: "string",
        description: "Unknown parameter type",
        required: !isOptional,
    };
}

/**
 * Create a ParameterSchema from a Zod schema
 */
export function createZodSchema<T>(schema: z.ZodType<T>): ParameterSchema<T> {
    return {
        shape: zodToSchemaShape(schema),
        validate: (input: unknown): Result<ValidationError, Validated<T>> => {
            const result = schema.safeParse(input);

            if (result.success) {
                return {
                    ok: true,
                    value: { _brand: "validated", value: result.data },
                };
            }

            // Extract the first error for simplicity
            const firstError = result.error.errors[0];
            if (!firstError) {
                return {
                    ok: false,
                    error: {
                        kind: "validation",
                        field: "value",
                        message: "Validation failed",
                    },
                };
            }
            return {
                ok: false,
                error: {
                    kind: "validation",
                    field: firstError.path.length > 0 ? firstError.path.join(".") : "input",
                    message: firstError.message,
                },
            };
        },
    };
}

/**
 * Helper function to create schemas with descriptions
 */
export function withDescription<T extends z.ZodType<unknown>>(schema: T, description: string): T {
    return schema.describe(description);
}

/**
 * Common schema patterns for tools
 */
export const ToolSchemas = {
    /**
     * File path schema with validation
     */
    filePath: (description = "File path") =>
        z
            .string()
            .describe(description)
            .refine((path) => !path.includes(".."), "Path must not contain directory traversal"),

    /**
     * Command schema with safety checks
     */
    command: (description = "Shell command") =>
        z
            .string()
            .describe(description)
            .refine((cmd) => !cmd.includes("rm -rf"), "Dangerous commands are not allowed"),

    /**
     * Phase schema
     */
    phase: () => {
        // Import here to avoid circular dependencies
        const { ALL_PHASES } = require("@/conversations/phases");
        return z
            .enum(ALL_PHASES as [string, ...string[]])
            .describe("Conversation phase");
    },

    /**
     * Agent pubkey schema
     */
    agentPubkey: () =>
        z
            .string()
            .length(64)
            .regex(/^[0-9a-f]{64}$/)
            .describe("Agent public key"),

    /**
     * Non-empty string
     */
    nonEmptyString: (description = "Non-empty string") => z.string().min(1).describe(description),

    /**
     * Optional field helper
     */
    optional: <T extends z.ZodType<unknown>>(schema: T) => schema.optional(),

    /**
     * Array with at least one element
     */
    nonEmptyArray: <T extends z.ZodType<unknown>>(schema: T, description = "Non-empty array") =>
        z.array(schema).min(1).describe(description),
};

/**
 * Convert MCP tool input schema to Zod schema
 */
export function mcpSchemaToZod(mcpSchema: MCPSchema): z.ZodType<unknown> {
    if (!mcpSchema.properties) {
        return z.object({});
    }

    const zodShape: Record<string, z.ZodType<unknown>> = {};

    for (const [propName, propDef] of Object.entries(mcpSchema.properties)) {
        const isRequired = mcpSchema.required?.includes(propName) ?? false;

        let zodField: z.ZodType<unknown>;

        switch (propDef.type) {
            case "string":
                zodField = z.string();
                if (propDef.enum && propDef.enum.length > 0) {
                    zodField = z.enum(propDef.enum as [string, ...string[]]);
                }
                if (propDef.minLength) {
                    zodField = (zodField as z.ZodString).min(propDef.minLength);
                }
                if (propDef.maxLength) {
                    zodField = (zodField as z.ZodString).max(propDef.maxLength);
                }
                break;

            case "number":
            case "integer":
                zodField = propDef.type === "integer" ? z.number().int() : z.number();
                if (propDef.minimum !== undefined) {
                    zodField = (zodField as z.ZodNumber).min(propDef.minimum);
                }
                if (propDef.maximum !== undefined) {
                    zodField = (zodField as z.ZodNumber).max(propDef.maximum);
                }
                break;

            case "boolean":
                zodField = z.boolean();
                break;

            case "array": {
                const itemSchema = propDef.items ? mcpPropertyToZod(propDef.items) : z.unknown();
                let arrayField = z.array(itemSchema);
                if (propDef.minItems !== undefined) {
                    arrayField = arrayField.min(propDef.minItems);
                }
                if (propDef.maxItems !== undefined) {
                    arrayField = arrayField.max(propDef.maxItems);
                }
                zodField = arrayField;
                break;
            }

            case "object":
                if (propDef.properties) {
                    zodField = mcpSchemaToZod({
                        properties: propDef.properties,
                        required: propDef.required,
                    });
                } else {
                    zodField = z.record(z.unknown());
                }
                break;

            default:
                zodField = z.unknown();
        }

        if (propDef.description) {
            zodField = zodField.describe(propDef.description);
        }

        zodShape[propName] = isRequired ? zodField : zodField.optional();
    }

    return z.object(zodShape);
}

/**
 * Convert a single MCP property definition to Zod schema
 */
function mcpPropertyToZod(propDef: MCPPropertyDefinition): z.ZodType<unknown> {
    switch (propDef.type) {
        case "string":
            return z.string();
        case "number":
        case "integer":
            return propDef.type === "integer" ? z.number().int() : z.number();
        case "boolean":
            return z.boolean();
        case "array":
            return z.array(propDef.items ? mcpPropertyToZod(propDef.items) : z.unknown());
        case "object":
            return z.record(z.unknown());
        default:
            return z.unknown();
    }
}

/**
 * Type inference helper for Zod schemas
 */
export type InferZodSchema<T extends z.ZodType<unknown>> = z.infer<T>;
