import { z } from "zod";

/**
 * Unified configuration types for TENEX
 * All configuration files use the same schemas for both global and project contexts
 */

// =====================================================================================
// MAIN CONFIG SCHEMA (config.json)
// =====================================================================================

export interface TenexConfig {
  // Global fields
  whitelistedPubkeys?: string[];

  // Project fields (optional for global config)
  description?: string;
  repoUrl?: string;
  projectNaddr?: string;
  paths?: {
    inventory?: string;
  };
}

export const TenexConfigSchema = z.object({
  whitelistedPubkeys: z.array(z.string()).optional(),
  description: z.string().optional(),
  repoUrl: z.string().optional(),
  projectNaddr: z.string().optional(),
  paths: z
    .object({
      inventory: z.string().optional(),
    })
    .optional(),
});

// =====================================================================================
// AGENTS SCHEMA (agents.json)
// =====================================================================================

export interface TenexAgents {
  [agentSlug: string]: {
    nsec: string;
    file: string;
    eventId?: string;
  };
}

export const TenexAgentsSchema = z.record(
  z.object({
    nsec: z.string(),
    file: z.string(),
    eventId: z.string().optional(),
  })
);

// =====================================================================================
// LLM SCHEMA (llms.json)
// =====================================================================================

import type { LLMModelConfig, ProviderAuth } from "@/llm/types";

export interface TenexLLMs {
  configurations: {
    [namedConfig: string]: LLMModelConfig;
  };
  defaults?: {
    agents?: string;
    [agentSlug: string]: string | undefined;
  };
  credentials: {
    [namedCredential: string]: ProviderAuth;
  };
}

import { LLM_PROVIDERS } from "@/llm/types";

export const TenexLLMsSchema = z.object({
  configurations: z.record(
    z.object({
      provider: z.enum(LLM_PROVIDERS),
      model: z.string(),
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      enableCaching: z.boolean().optional(),
    })
  ),
  defaults: z.record(z.string()).optional().default({}),
  credentials: z.record(
    z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      headers: z.record(z.string()).optional(),
    })
  ),
});

// =====================================================================================
// MCP SCHEMA (mcp.json)
// =====================================================================================

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
  allowedPaths?: string[];
  eventId?: string; // Nostr event ID this server was installed from
}

export interface TenexMCP {
  servers: Record<string, MCPServerConfig>;
  enabled: boolean;
}

export const MCPServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  eventId: z.string().optional(),
});

export const TenexMCPSchema = z.object({
  servers: z.record(MCPServerConfigSchema).default({}),
  enabled: z.boolean().default(true),
});

// =====================================================================================
// LOADED CONFIGURATION STATE
// =====================================================================================

export interface LoadedConfig {
  config: TenexConfig;
  agents: TenexAgents;
  llms: TenexLLMs;
  mcp: TenexMCP;
}

// =====================================================================================
// HELPER TYPES
// =====================================================================================

export type ConfigFile = "config.json" | "agents.json" | "llms.json" | "mcp.json";

export interface ConfigPaths {
  global: string;
  project?: string;
}
