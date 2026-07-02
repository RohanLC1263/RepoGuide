import { LanceDbMemoryStore } from './lanceDbMemoryStore';
import { LocalEmbeddingProvider } from './embeddings/localEmbeddingProvider';
import * as path from 'path';

export class MemoryStoreFactory {
    private static instance: LanceDbMemoryStore | null = null;
    private static initializationPromise: Promise<LanceDbMemoryStore> | null = null;

    /**
     * Gets or creates the canonical MemoryStore instance.
     * Ensures all platform components use the exact same DB path and table.
     */
    public static async getMemoryStore(workspaceRoot: string): Promise<LanceDbMemoryStore> {
        if (this.instance) {
            return this.instance;
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = (async () => {
            const embeddingProvider = new LocalEmbeddingProvider();
            await embeddingProvider.initialize();
            
            // Canonical location: .repoguide/lancedb
            const dbPath = path.join(workspaceRoot, '.repoguide', 'lancedb');
            const store = new LanceDbMemoryStore(embeddingProvider, dbPath);
            await store.initialize();
            
            this.instance = store;
            return store;
        })();

        return this.initializationPromise;
    }
}
