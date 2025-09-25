import { pipeline, type Pipeline } from '@xenova/transformers';

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
    
    constructor(modelId: string = 'Xenova/all-MiniLM-L6-v2') {
        this.modelId = modelId;
    }
    
    private async ensurePipeline(): Promise<Pipeline> {
        if (!this.pipeline) {
            this.pipeline = await pipeline('feature-extraction', this.modelId) as Pipeline;
        }
        return this.pipeline;
    }
    
    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }
    
    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const pipe = await this.ensurePipeline();
        const results: Float32Array[] = [];
        
        for (const text of texts) {
            const output = await pipe(text, { pooling: 'mean', normalize: true });
            
            // Convert to Float32Array if needed
            if (output.data instanceof Float32Array) {
                results.push(output.data);
            } else {
                results.push(new Float32Array(output.data));
            }
            
            // Cache dimensions from first embedding
            if (this.dimensions === null && results.length > 0) {
                this.dimensions = results[0].length;
            }
        }
        
        return results;
    }
    
    public async getDimensions(): Promise<number> {
        if (this.dimensions === null) {
            // Generate a dummy embedding to get dimensions
            await this.embed('test');
        }
        return this.dimensions!;
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
    
    constructor(apiKey: string, modelId: string = 'text-embedding-3-small') {
        this.apiKey = apiKey;
        this.modelId = modelId;
        // Default dimensions for common models
        this.dimensions = modelId === 'text-embedding-3-small' ? 1536 : 
                         modelId === 'text-embedding-3-large' ? 3072 : 
                         modelId === 'text-embedding-ada-002' ? 1536 : 1536;
    }
    
    public async embed(text: string): Promise<Float32Array> {
        const embeddings = await this.embedBatch([text]);
        return embeddings[0];
    }
    
    public async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.modelId,
                input: texts
            })
        });
        
        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        return data.data.map((item: any) => new Float32Array(item.embedding));
    }
    
    public async getDimensions(): Promise<number> {
        return this.dimensions;
    }
    
    public getModelId(): string {
        return this.modelId;
    }
}