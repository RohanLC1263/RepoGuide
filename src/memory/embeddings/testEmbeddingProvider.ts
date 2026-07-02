import { EmbeddingProvider } from './embeddingProvider';

export class TestEmbeddingProvider implements EmbeddingProvider {
    private vectorSize = 384; // Matches all-MiniLM-L6-v2 dimensionality

    async embed(text: string): Promise<number[]> {
        // Deterministic, lightweight pseudo-embedding based on string hashing.
        // Used ONLY for CI/testing without downloading models.
        const vec = new Array(this.vectorSize).fill(0);
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = (hash << 5) - hash + text.charCodeAt(i);
            hash |= 0;
        }
        
        const seed = Math.abs(hash);
        for (let i = 0; i < this.vectorSize; i++) {
            vec[i] = (seed + i) % 100 / 100.0;
        }
        
        const mag = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
        return mag === 0 ? vec : vec.map(v => v / mag);
    }
}
