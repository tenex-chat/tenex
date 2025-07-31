/**
 * First-principles type system for TENEX tools
 *
 * Core philosophy:
 * - Type safety through algebraic data types
 * - Direct async/await for simplicity
 * - Explicit error handling with Result types
 */

import type { Phase } from "@/conversations/phases";
import type { Agent } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import type { ConversationManager } from "@/conversations/ConversationManager";
import type { NostrPublisher } from "@/nostr/NostrPublisher";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// ============================================================================
// Core Result Type
// ============================================================================

// Result type for fallible operations
export type Result<E, A> =
    | { readonly ok: true; readonly value: A }
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
// Control Flow and Termination Types
// ============================================================================

export interface ContinueFlow {
    readonly type: "continue";
    readonly routing: RoutingDecision;
}

export interface RoutingDecision {
    readonly phase?: Phase;
    readonly agents: NonEmptyArray<string>; // Agent pubkeys
    readonly reason: string;
    readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Termination types that end execution
 */
export type Termination = Complete | EndConversation;

export interface Complete {
    readonly type: "complete";
    readonly completion: CompletionSummary;
}

export interface EndConversation {
    readonly type: "end_conversation";
    readonly result: ConversationResult;
}

export interface CompletionSummary {
    readonly response: string;
    readonly summary: string;
    readonly nextAgent: string;
}

export interface ConversationResult {
    readonly response: string;
    readonly summary: string;
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

export const success = <A>(value: A): Result<never, A> => ({
    ok: true,
    value,
});

export const failure = <E>(error: E): Result<E, never> => ({
    ok: false,
    error,
});
