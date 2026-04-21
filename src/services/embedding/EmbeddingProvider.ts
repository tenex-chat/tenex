import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FeatureExtractionPipeline, type Tensor, env, pipeline } from "@huggingface/transformers";
import { getTenexBasePath } from "@/constants";
import { logger } from "@/utils/logger";

export interface EmbeddingProvider {
    /**
     * Generate embedding for a single text
     */
    embed(text: string): Promise<Float32Array>;

    /**
     * Generate embeddings for multiple texts
     */
    embedBatch(texts: string[]): Promise<Float32Array[]>;

    /**
     * Get the dimension of the embeddings
     */
    getDimensions(): Promise<number>;

    /**
     * Get model identifier
     */
    getModelId(): string;
}

const EMBEDDING_DIAGNOSTIC_EXCERPT_CHARS = 240;

function getTextDiagnostic(text: string, index: number): Record<string, unknown> {
    return {
        index,
        chars: text.length,
        bytes: Buffer.byteLength(text, "utf8"),
        lines: text.length === 0 ? 0 : text.split("\n").length,
        sha256: createHash("sha256").update(text).digest("hex"),
        prefix: text.slice(0, EMBEDDING_DIAGNOSTIC_EXCERPT_CHARS),
        suffix: text.length > EMBEDDING_DIAGNOSTIC_EXCERPT_CHARS
            ? text.slice(-EMBEDDING_DIAGNOSTIC_EXCERPT_CHARS)
            : undefined,
    };
}

function getEmbeddingRequestDiagnostic(texts: string[]): Record<string, unknown> {
    const lengths = texts.map((text) => text.length);
    return {
        inputCount: texts.length,
        totalChars: lengths.reduce((sum, length) => sum + length, 0),
        maxChars: lengths.length > 0 ? Math.max(...lengths) : 0,
        minChars: lengths.length > 0 ? Math.min(...lengths) : 0,
        inputs: texts.map(getTextDiagnostic),
    };
}

function getEmbeddingFailureArtifactPath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const random = Math.random().toString(36).slice(2, 8);
    const dir = join(getTenexBasePath(), "daemon", "embedding-failures");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${timestamp}-${process.pid}-${random}.json`);
}

function writeEmbeddingFailureArtifact(params: {
    endpoint: string;
    model: string;
    texts: string[];
    responseStatus: number;
    responseStatusText: string;
    responseText: string;
    failureKind: string;
}): string | undefined {
    try {
        const artifactPath = getEmbeddingFailureArtifactPath();
        const payload = {
            timestamp: new Date().toISOString(),
            failureKind: params.failureKind,
            replay: {
                method: "POST",
                endpoint: params.endpoint,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer <redacted>",
                },
                body: {
                    model: params.model,
                    input: params.texts,
                },
            },
            response: {
                status: params.responseStatus,
                statusText: params.responseStatusText,
                body: params.responseText,
            },
        };
        writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
        return artifactPath;
    } catch (error) {
        logger.warn("Failed to write embedding failure artifact", {
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}

/**
 * Local transformer-based embedding provider using @huggingface/transformers
 */
export class LocalTransformerEmbeddingProvider implements EmbeddingProvider {
    private extractorPipeline: FeatureExtractionPipeline | null = null;
    private modelId: string;
    private dimensions: number | null = null;
    private initializationPromise: Promise<void> | null = null;

    constructor(modelId = "Xenova/all-MiniLM-L6-v2") {
        this.modelId = modelId;
        this.initializationPromise = this.initialize();
    }

    /**
     * Initialize the provider by generating a test embedding to determine dimensions.
     * This ensures dimensions are always available after construction completes.
     */
    private async initialize(): Promise<void> {
        try {
            await this.tryInitializePipeline();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Corrupted cached model — clear cache and retry once
            if (message.includes("Protobuf parsing failed") || message.includes("Load model from")) {
                const cacheDir = join(env.cacheDir as string, ...this.modelId.split("/"));
                logger.warn(`Corrupted model cache detected at ${cacheDir}, clearing and retrying`);
                try {
                    rmSync(cacheDir, { recursive: true, force: true });
                } catch {
                    // Ignore cache-clearing errors
                }
                this.extractorPipeline = null;
                try {
                    await this.tryInitializePipeline();
                    return;
                } catch (retryError) {
                    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    throw new Error(`Failed to initialize embedding provider after cache clear: ${retryMessage}`, {
                        cause: retryError,
                    });
                }
            }
            throw new Error(`Failed to initialize embedding provider: ${message}`, { cause: error });
        }
    }

    private async tryInitializePipeline(): Promise<void> {
        const pipe = await this.ensurePipeline();
        const output = await pipe("test", { pooling: "mean", normalize: true });
        const embedding = this.tensorToFloat32Array(output);
        this.dimensions = embedding.length;
    }

    private tensorToFloat32Array(tensor: Tensor): Float32Array {
        return tensor.data instanceof Float32Array
            ? tensor.data
            : new Float32Array(tensor.data as ArrayLike<number>);
    }

    private async ensurePipeline(): Promise<FeatureExtractionPipeline> {
        if (!this.extractorPipeline) {
            this.extractorPipeline = await pipeline("feature-extraction", this.modelId);
        }
        return this.extractorPipeline;
    }

    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }

    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        await this.ensureInitialized();
        const pipe = await this.ensurePipeline();
        const results: Float32Array[] = [];

        for (const text of texts) {
            const output = await pipe(text, { pooling: "mean", normalize: true });
            results.push(this.tensorToFloat32Array(output));
        }

        return results;
    }

    /**
     * Ensure the provider has completed initialization.
     * This guarantees dimensions are available before any operations.
     */
    private async ensureInitialized(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
            this.initializationPromise = null;
        }
    }

    /**
     * Get embedding dimensions.
     * Dimensions are guaranteed to be available after initialization completes.
     */
    public async getDimensions(): Promise<number> {
        await this.ensureInitialized();

        if (this.dimensions === null) {
            throw new Error(
                "Embedding dimensions not available after initialization. " +
                    "This indicates a critical initialization failure."
            );
        }

        return this.dimensions;
    }

    public getModelId(): string {
        return this.modelId;
    }
}

export class MockEmbeddingProvider implements EmbeddingProvider {
    private readonly dimensions: number;
    private readonly modelId: string;

    constructor(modelId = "mock/all-MiniLM-L6-v2", dimensions = 384) {
        this.modelId = modelId;
        this.dimensions = dimensions;
    }

    public async embed(text: string): Promise<Float32Array> {
        return this.buildEmbedding(text);
    }

    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return texts.map((text) => this.buildEmbedding(text));
    }

    public async getDimensions(): Promise<number> {
        return this.dimensions;
    }

    public getModelId(): string {
        return this.modelId;
    }

    private buildEmbedding(text: string): Float32Array {
        const vector = new Float32Array(this.dimensions);
        const normalizedText = text.trim().length > 0 ? text : " ";

        for (let index = 0; index < normalizedText.length; index++) {
            const code = normalizedText.charCodeAt(index);
            const slot = (code + (index * 31)) % this.dimensions;
            vector[slot] += ((code % 97) + 1) / 100;
        }

        let magnitude = 0;
        for (const value of vector) {
            magnitude += value * value;
        }

        if (magnitude > 0) {
            const scale = 1 / Math.sqrt(magnitude);
            for (let index = 0; index < vector.length; index++) {
                vector[index] *= scale;
            }
        }

        return vector;
    }
}

/**
 * OpenAI-compatible embedding provider
 * Works with OpenAI, OpenRouter, and other OpenAI-compatible APIs
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    private apiKey: string;
    private modelId: string;
    private baseUrl: string;
    private dimensions: number | null = null;

    constructor(apiKey: string, modelId = "text-embedding-3-small", baseUrl = "https://api.openai.com/v1") {
        this.apiKey = apiKey;
        this.modelId = modelId;
        this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    }

    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }

    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const endpoint = `${this.baseUrl}/embeddings`;
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.modelId,
                input: texts,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            const artifactPath = writeEmbeddingFailureArtifact({
                endpoint,
                model: this.modelId,
                texts,
                responseStatus: response.status,
                responseStatusText: response.statusText,
                responseText: errorBody,
                failureKind: "http_error",
            });
            logger.error("Embedding request failed", {
                endpoint,
                model: this.modelId,
                status: response.status,
                statusText: response.statusText,
                request: getEmbeddingRequestDiagnostic(texts),
                artifactPath,
                response: errorBody.substring(0, 1000),
            });
            throw new Error(`OpenAI API error: ${response.statusText} - ${errorBody}`);
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const responseText = await response.text();
        let data: EmbeddingResponse;

        try {
            data = JSON.parse(responseText) as EmbeddingResponse;
        } catch (parseError) {
            const artifactPath = writeEmbeddingFailureArtifact({
                endpoint,
                model: this.modelId,
                texts,
                responseStatus: response.status,
                responseStatusText: response.statusText,
                responseText,
                failureKind: "invalid_json",
            });
            logger.error("Failed to parse embedding response", {
                responseText: responseText.substring(0, 500),
                parseError,
                endpoint,
                model: this.modelId,
                request: getEmbeddingRequestDiagnostic(texts),
                artifactPath,
            });
            throw new Error(`Invalid JSON response from embeddings API: ${parseError}`, {
                cause: parseError,
            });
        }

        if (!data.data) {
            const artifactPath = writeEmbeddingFailureArtifact({
                endpoint,
                model: this.modelId,
                texts,
                responseStatus: response.status,
                responseStatusText: response.statusText,
                responseText,
                failureKind: "missing_data",
            });
            logger.error("Embedding response missing 'data' field", {
                response: responseText.substring(0, 500),
                keys: Object.keys(data),
                endpoint,
                model: this.modelId,
                request: getEmbeddingRequestDiagnostic(texts),
                artifactPath,
            });
            throw new Error(`Embedding response missing 'data' field. Response keys: ${Object.keys(data).join(", ")}`);
        }

        const embeddings = data.data.map((item) => new Float32Array(item.embedding));

        // Cache dimensions from first successful response
        if (this.dimensions === null && embeddings.length > 0) {
            this.dimensions = embeddings[0].length;
        }

        return embeddings;
    }

    public async getDimensions(): Promise<number> {
        // If we haven't cached dimensions yet, make a test embedding call
        if (this.dimensions === null) {
            await this.embed("test");
        }
        if (this.dimensions === null) {
            throw new Error("Failed to determine embedding dimensions after test embed call");
        }
        return this.dimensions;
    }

    public getModelId(): string {
        return this.modelId;
    }
}

/**
 * Ollama embedding provider
 * Connects to local Ollama service for embeddings
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
    private modelId: string;
    private baseUrl: string;
    private dimensions: number | null = null;

    constructor(modelId = "nomic-embed-text", baseUrl = "http://localhost:11434") {
        this.modelId = modelId;
        this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    }

    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }

    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const embeddings: Float32Array[] = [];

        // Ollama API expects single text per request
        for (const text of texts) {
            const response = await fetch(`${this.baseUrl}/api/embed`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: this.modelId,
                    input: text,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Ollama API error: ${response.statusText} - ${errorText}`);
            }

            interface OllamaEmbedResponse {
                embeddings?: number[][];
                embedding?: number[];
            }

            const data = (await response.json()) as OllamaEmbedResponse;

            // Handle both response formats (some models return 'embedding', others 'embeddings')
            let embedding: number[];
            if (data.embeddings && data.embeddings.length > 0) {
                embedding = data.embeddings[0];
            } else if (data.embedding) {
                embedding = data.embedding;
            } else {
                throw new Error("Ollama response missing embedding data");
            }

            const float32Embedding = new Float32Array(embedding);
            embeddings.push(float32Embedding);

            // Cache dimensions from first successful response
            if (this.dimensions === null) {
                this.dimensions = embedding.length;
            }
        }

        return embeddings;
    }

    public async getDimensions(): Promise<number> {
        if (this.dimensions === null) {
            await this.embed("test");
        }
        if (this.dimensions === null) {
            throw new Error("Failed to determine embedding dimensions after test embed call");
        }
        return this.dimensions;
    }

    public getModelId(): string {
        return this.modelId;
    }
}
