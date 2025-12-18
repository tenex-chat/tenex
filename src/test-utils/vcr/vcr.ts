import type {
    LanguageModelV2,
    LanguageModelV2CallOptions,
    LanguageModelV2Content,
    LanguageModelV2FinishReason,
} from "@ai-sdk/provider";
import {
    loadCassette,
    saveCassette,
    findInteraction,
    addInteraction,
} from "./cassette";
import { hashRequest, explainHash } from "./hash";
import type { VCRConfig, VCRCassette, VCRInteraction } from "./types";

/**
 * VCR (Video Cassette Recorder) for LLM testing.
 * Records and plays back LLM interactions for deterministic testing.
 */
export class VCR {
    private cassette: VCRCassette | null = null;
    private config: VCRConfig;
    private isInitialized = false;

    constructor(config: VCRConfig) {
        this.config = config;
    }

    /**
     * Initializes the VCR by loading the cassette.
     * Must be called before wrapping a model.
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        // Extract cassette name from path
        const cassetteName =
            this.config.cassettePath.split("/").pop()?.replace(".json", "") ||
            "unnamed";

        this.cassette = await loadCassette(
            this.config.cassettePath,
            cassetteName
        );
        this.isInitialized = true;
    }

    /**
     * Wraps a language model with VCR recording/playback capabilities.
     *
     * @param model - The language model to wrap
     * @returns A wrapped model that records or plays back interactions
     */
    wrap(model: LanguageModelV2): LanguageModelV2 {
        if (!this.isInitialized) {
            throw new Error(
                "VCR must be initialized before wrapping a model. Call vcr.initialize() first."
            );
        }

        const vcr = this;

        return {
            specificationVersion: "v2" as const,
            provider: `vcr-${model.provider}`,
            modelId: model.modelId,
            supportedUrls: model.supportedUrls,

            async doGenerate(options: LanguageModelV2CallOptions) {
                const hash = hashRequest(options);
                const explanation = explainHash(options);

                if (vcr.config.mode === "passthrough") {
                    return await model.doGenerate(options);
                }

                if (vcr.config.mode === "playback") {
                    const interaction = findInteraction(vcr.cassette!, hash);

                    if (!interaction) {
                        const message = `No recorded interaction found for hash ${hash}\nRequest: ${explanation}`;
                        if (vcr.config.strictMatching) {
                            throw new Error(message);
                        }
                        console.warn(
                            `[VCR] ${message}\nFalling back to real LLM.`
                        );
                        return await model.doGenerate(options);
                    }

                    console.log(
                        `[VCR] Playing back interaction for: ${explanation}`
                    );
                    return {
                        content: interaction.response
                            .content as LanguageModelV2Content[],
                        finishReason: interaction.response
                            .finishReason as LanguageModelV2FinishReason,
                        usage: interaction.response.usage,
                        providerMetadata:
                            interaction.response.providerMetadata,
                        warnings: [],
                    };
                }

                // mode === "record"
                console.log(`[VCR] Recording interaction for: ${explanation}`);
                const startTime = Date.now();
                const result = await model.doGenerate(options);
                const duration = Date.now() - startTime;

                const interaction: VCRInteraction = {
                    hash,
                    request: {
                        prompt: options.prompt,
                        temperature: options.temperature,
                        maxOutputTokens: options.maxOutputTokens,
                        tools: options.tools,
                        toolChoice: options.toolChoice,
                    },
                    response: {
                        content: result.content.map((c) => {
                            // Simplify content for serialization
                            if (c.type === "text") {
                                return { type: "text", text: c.text };
                            }
                            if (c.type === "tool-call") {
                                return {
                                    type: "tool-call",
                                    toolCallId: c.toolCallId,
                                    toolName: c.toolName,
                                    input: c.input,
                                };
                            }
                            if (c.type === "tool-result") {
                                return {
                                    type: "tool-result",
                                    toolCallId: c.toolCallId,
                                    toolName: c.toolName,
                                    result: c.result,
                                };
                            }
                            return c;
                        }),
                        finishReason: result.finishReason,
                        usage: result.usage,
                        providerMetadata: result.providerMetadata,
                    },
                    metadata: {
                        timestamp: new Date().toISOString(),
                        modelId: model.modelId,
                        provider: model.provider,
                        duration,
                    },
                };

                addInteraction(vcr.cassette!, interaction);

                if (vcr.config.autoSave) {
                    await vcr.save();
                }

                return result;
            },

            async doStream(options: LanguageModelV2CallOptions) {
                // For streaming, we currently don't support playback
                // Always pass through to the real model
                // In the future, we could record the stream parts
                console.log(
                    "[VCR] Streaming not yet supported, passing through to real model"
                );
                return await model.doStream(options);
            },
        };
    }

    /**
     * Saves the current cassette to disk.
     */
    async save(): Promise<void> {
        if (!this.cassette) {
            throw new Error("No cassette loaded");
        }
        await saveCassette(this.config.cassettePath, this.cassette);
    }

    /**
     * Disposes the VCR and saves the cassette if in record mode.
     */
    async dispose(): Promise<void> {
        if (this.config.mode === "record" && this.cassette) {
            await this.save();
        }
    }

    /**
     * Gets the current cassette.
     */
    getCassette(): VCRCassette | null {
        return this.cassette;
    }
}

/**
 * Creates a VCR instance with the given configuration.
 *
 * @param config - VCR configuration
 * @returns A new VCR instance (not yet initialized)
 */
export function createVCR(config: VCRConfig): VCR {
    return new VCR(config);
}
