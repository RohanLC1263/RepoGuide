import { MemoryRetriever, MemoryRecord, MemoryStore, MemoryQuery } from './memoryTypes';

export class LanceDbMemoryRetriever implements MemoryRetriever {
    constructor(private store: MemoryStore) {}

    async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
        return this.store.search(query);
    }
}
