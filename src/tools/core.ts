/**
 * First-principles type system for TENEX tools
 *
 * Core philosophy:
 * - Type safety through algebraic data types
 * - Direct async/await for simplicity
 * - Explicit error handling with Result types
 */

// ============================================================================
// Core Result Type
// ============================================================================

// Import metadata type from executor
import type { ToolExecutionMetadata } from "./executor";

// Result type for fallible operations with optional metadata
export type Result<E, A> =
  | { readonly ok: true; readonly value: A; readonly metadata?: ToolExecutionMetadata }
  | { readonly ok: false; readonly error: E };

// ============================================================================
// Simple Tool Interface
// ============================================================================

// Import unified ExecutionContext
import type { ExecutionContext } from "@/agents/execution/types";

// ============================================================================
// Tool Type Definition
// ============================================================================

/**
 * Simple, unified tool interface
 */
export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ParameterSchema<Input>;
  readonly promptFragment?: string;
  readonly execute: (
    input: Validated<Input>,
    context: ExecutionContext
  ) => Promise<Result<ToolError, Output>>;
}

// ============================================================================
// Conversation Result Type
// ============================================================================

export interface ConversationResult {
  readonly response: string;
  readonly success: boolean;
  readonly artifacts?: ReadonlyArray<string>;
}

// ============================================================================
// Parameter Schema and Validation
// ============================================================================

export interface ParameterSchema<T> {
  readonly shape: SchemaShape;
  readonly validate: (input: unknown) => Result<ValidationError, Validated<T>>;
}

export type SchemaShape =
  | { type: "string"; description: string; enum?: ReadonlyArray<string>; required?: boolean }
  | { type: "number"; description: string; min?: number; max?: number; required?: boolean }
  | { type: "boolean"; description: string; required?: boolean }
  | { type: "array"; description: string; items: SchemaShape; required?: boolean }
  | {
      type: "object";
      description: string;
      properties: Readonly<Record<string, SchemaShape>>;
      required?: ReadonlyArray<string>;
    };

// Branded type for validated input
export interface Validated<T> {
  readonly _brand: "validated";
  readonly value: T;
}

// ============================================================================
// Error Types
// ============================================================================

export type ToolError = ValidationError | ExecutionError | SystemError;

export interface ValidationError {
  readonly kind: "validation";
  readonly field: string;
  readonly message: string;
}

export interface ExecutionError {
  readonly kind: "execution";
  readonly tool: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface SystemError {
  readonly kind: "system";
  readonly message: string;
  readonly stack?: string;
}

// ============================================================================
// Helper Types
// ============================================================================

// Non-empty array type
export interface NonEmptyArray<T> extends ReadonlyArray<T> {
  readonly 0: T;
}

// Helper type guards
export const isNonEmptyArray = <T>(array: ReadonlyArray<T>): array is NonEmptyArray<T> =>
  array.length > 0;

// ============================================================================
// Result Constructors
// ============================================================================

export const success = <A>(value: A, metadata?: ToolExecutionMetadata): Result<never, A> => ({
  ok: true,
  value,
  ...(metadata && { metadata }),
});

export const failure = <E>(error: E): Result<E, never> => ({
  ok: false,
  error,
});
