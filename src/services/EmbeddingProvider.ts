import { pipeline, type Pipeline } from "@xenova/transformers";

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
 * Local transformer-based embedding provider using Xenova/transformers
 */
export class LocalTransformerEmbeddingProvider implements EmbeddingProvider {
    private pipeline: Pipeline | null = null;
    private modelId: string;
    private dimensions: number | null = null;
    private initializationPromise: Promise<void> | null = null;
    
    constructor(modelId: string = "Xenova/all-MiniLM-L6-v2") {
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
            
            const embedding = output.data instanceof Float32Array 
                ? output.data 
                : new Float32Array(output.data);
            
            this.dimensions = embedding.length;
        } catch (error) {
            throw new Error(
                `Failed to initialize embedding provider: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
    
    private async ensurePipeline(): Promise<Pipeline> {
        if (!this.pipeline) {
            this.pipeline = await pipeline("feature-extraction", this.modelId) as Pipeline;
        }
        return this.pipeline;
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
            
            if (output.data instanceof Float32Array) {
                results.push(output.data);
            } else {
                results.push(new Float32Array(output.data));
            }
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
 * OpenAI-compatible embedding provider (for future use)
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    private apiKey: string;
    private modelId: string;
    private dimensions: number;
    
    constructor(apiKey: string, modelId: string = "text-embedding-3-small") {
        this.apiKey = apiKey;
        this.modelId = modelId;
        // Default dimensions for common models
        this.dimensions = modelId === "text-embedding-3-small" ? 1536 : 
                         modelId === "text-embedding-3-large" ? 3072 : 
                         modelId === "text-embedding-ada-002" ? 1536 : 1536;
    }
    
    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }
    
    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.modelId,
                input: texts
            })
        });
        
        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data = await response.json() as EmbeddingResponse;

        return data.data.map((item) => new Float32Array(item.embedding));
    }
    
    public async getDimensions(): Promise<number> {
        return this.dimensions;
    }
    
    public getModelId(): string {
        return this.modelId;
    }
}