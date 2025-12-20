import type {
    LanguageModelV2CallOptions,
    LanguageModelV2Usage,
    LanguageModelV2FinishReason,
    SharedV2ProviderMetadata,
} from "@ai-sdk/provider";

/**
 * A single recorded interaction between the test and the LLM
 */
export interface VCRInteraction {
    /** Hash of the request for matching (16 chars) */
    hash: string;
    /** The request that was made */
    request: {
        prompt: LanguageModelV2CallOptions["prompt"];
        temperature?: number;
        maxOutputTokens?: number;
        tools?: LanguageModelV2CallOptions["tools"];
        toolChoice?: LanguageModelV2CallOptions["toolChoice"];
    };
    /** The response that was returned */
    response: {
        content: Array<{
            type: string;
            text?: string;
            toolCallId?: string;
            toolName?: string;
            input?: string;
            result?: unknown;
        }>;
        finishReason: LanguageModelV2FinishReason;
        usage: LanguageModelV2Usage;
        providerMetadata?: SharedV2ProviderMetadata;
    };
    /** Metadata about the interaction */
    metadata?: {
        timestamp?: string;
        modelId?: string;
        provider?: string;
        duration?: number;
    };
}

/**
 * A cassette file containing multiple interactions
 */
export interface VCRCassette {
    /** Cassette name */
    name: string;
    /** Format version for backwards compatibility */
    version: string;
    /** Recorded interactions */
    interactions: VCRInteraction[];
    /** Cassette metadata */
    metadata?: {
        createdAt?: string;
        description?: string;
    };
}

/**
 * VCR operating mode
 */
export type VCRMode =
    /** Record new interactions and save to cassette */
    | "record"
    /** Play back recorded interactions from cassette */
    | "playback"
    /** Pass through to real LLM without recording */
    | "passthrough";

/**
 * Configuration for VCR
 */
export interface VCRConfig {
    /** Path to cassette file */
    cassettePath: string;
    /** Operating mode */
    mode: VCRMode;
    /** Whether to throw error if no matching interaction found in playback mode */
    strictMatching?: boolean;
    /** Whether to save cassette after each interaction (default: false, saves on dispose) */
    autoSave?: boolean;
}
