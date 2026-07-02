import { MemoryRetriever, MemoryRecord, MemoryStore, MemoryQuery } from './memoryTypes';

export class InMemoryMemoryRetriever implements MemoryRetriever {
    constructor(private store: MemoryStore) {}

    async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
        // The Retriever delegates directly to the MemoryStore's query engine.
        // Additional business logic like telemetry, quota enforcement, or 
        // global scoping boundaries could be enforced here before calling store.search()
        return this.store.search(query);
    }
}
