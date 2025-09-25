import { isAbsolute, relative, resolve } from "node:path";
import type { ExecutionContext } from "@/agents/execution/types";
import { logger } from "@/utils/logger";
import { handleError } from "@/utils/error-handler";
import type { z } from "zod";

/**
 * Resolves and validates a file path to ensure it stays within the project boundaries.
 *
 * @param filePath - The file path to validate (can be absolute or relative)
 * @param projectPath - The root project path
 * @returns The resolved absolute path if valid
 * @throws Error if the path would escape the project directory
 */
export function resolveAndValidatePath(filePath: string, projectPath: string): string {
  const fullPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath);
  const relativePath = relative(projectPath, fullPath);

  if (relativePath.startsWith("..")) {
    throw new Error(`Path outside project directory: ${filePath}`);
  }

  return fullPath;
}

/**
 * Standard response format for tool execution
 */
export interface ToolResponse {
  success: boolean;
  message?: string;
  error?: string;
  data?: any;
  [key: string]: any;
}

/**
 * Base class for tool execution errors
 */
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Standard wrapper for tool execution with error handling
 * Provides consistent error handling and response formatting
 */
export async function executeToolWithErrorHandling<T extends z.ZodType>(
  toolName: string,
  input: z.infer<T>,
  context: ExecutionContext,
  executeFn: (input: z.infer<T>, context: ExecutionContext) => Promise<ToolResponse>
): Promise<string> {
  logger.debug(`Executing tool: ${toolName}`, { input });
  
  try {
    const result = await executeFn(input, context);
    
    if (!result.success) {
      logger.warn(`Tool execution failed: ${toolName}`, { 
        error: result.error,
        input 
      });
    }
    
    return JSON.stringify(result, null, 2);
  } catch (error) {
    // Use project's error handling utilities
    const errorMessage = handleError(
      error,
      `Tool execution failed: ${toolName}`,
      { logLevel: 'error' }
    );
    
    // Return standardized error response
    const errorResponse: ToolResponse = {
      success: false,
      error: errorMessage,
      toolName
    };
    
    return JSON.stringify(errorResponse, null, 2);
  }
}

/**
 * Validate required fields in tool input
 */
export function validateRequiredFields<T extends Record<string, any>>(
  input: T,
  requiredFields: (keyof T)[],
  toolName: string
): void {
  const missingFields = requiredFields.filter(
    field => input[field] === undefined || input[field] === null
  );
  
  if (missingFields.length > 0) {
    throw new ToolExecutionError(
      `Missing required fields: ${missingFields.join(', ')}`,
      toolName
    );
  }
}

/**
 * Parse and validate numeric input with constraints
 */
export function parseNumericInput(
  value: number | undefined,
  defaultValue: number,
  constraints?: {
    min?: number;
    max?: number;
    integer?: boolean;
  }
): number {
  const result = value ?? defaultValue;
  
  if (constraints) {
    if (constraints.min !== undefined && result < constraints.min) {
      throw new Error(`Value ${result} is less than minimum ${constraints.min}`);
    }
    
    if (constraints.max !== undefined && result > constraints.max) {
      throw new Error(`Value ${result} is greater than maximum ${constraints.max}`);
    }
    
    if (constraints.integer && !Number.isInteger(result)) {
      throw new Error(`Value ${result} must be an integer`);
    }
  }
  
  return result;
}

/**
 * RAG-specific document interface for mapping
 */
export interface MappedRAGDocument {
  id?: string;
  content: string;
  metadata?: Record<string, any>;
  timestamp?: number;
  source?: string;
}

/**
 * Map LanceDB query result to RAG document format
 * Handles metadata parsing and field extraction
 */
export function mapLanceResultToDocument(result: any): MappedRAGDocument {
  return {
    id: result.id,
    content: result.content || '',
    metadata: parseDocumentMetadata(result.metadata),
    timestamp: result.timestamp,
    source: result.source
  };
}

/**
 * Parse document metadata from JSON string or object
 */
export function parseDocumentMetadata(
  metadata: string | Record<string, any> | undefined
): Record<string, any> {
  if (!metadata) return {};
  
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch (error) {
      logger.warn('Failed to parse document metadata', { error, metadata });
      return {};
    }
  }
  
  return metadata;
}

/**
 * Calculate relevance score from vector distance
 * Converts distance to similarity score (0-1 range)
 */
export function calculateRelevanceScore(distance: number | undefined): number {
  if (distance === undefined || distance === null) return 0;
  // Closer distance = higher similarity
  return Math.max(0, Math.min(1, 1 - distance));
}
