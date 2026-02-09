import { type FeatureExtractionPipeline, type Tensor, pipeline } from "@huggingface/transformers";

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
            const pipe = await this.ensurePipeline();
            const output = await pipe("test", { pooling: "mean", normalize: true });
            const embedding = this.tensorToFloat32Array(output);
            this.dimensions = embedding.length;
        } catch (error) {
            throw new Error(
                `Failed to initialize embedding provider: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                { cause: error }
            );
        }
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
        const response = await fetch(`${this.baseUrl}/embeddings`, {
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
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data = (await response.json()) as EmbeddingResponse;

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
        return this.dimensions!;
    }

    public getModelId(): string {
        return this.modelId;
    }
}
