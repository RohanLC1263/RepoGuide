import { EmbeddingProvider } from './embeddingProvider';

export class LocalEmbeddingProvider implements EmbeddingProvider {
    private extractor: any = null;
    private initialized = false;

    async initialize(): Promise<void> {
        try {
            // Dynamic import because @xenova/transformers is an ESM module
            const transformers = await import('@xenova/transformers');
            this.extractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                quantized: true,
            });
            this.initialized = true;
        } catch (err) {
            throw new Error(`LocalEmbeddingProvider failed to initialize: ${err}`);
        }
    }

    async embed(text: string): Promise<number[]> {
        if (!this.initialized) {
            await this.initialize();
        }
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data as Float32Array);
    }
}
