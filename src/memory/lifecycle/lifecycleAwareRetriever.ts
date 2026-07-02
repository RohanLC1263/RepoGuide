import { MemoryRetriever, MemoryQuery, MemoryRecord } from "../memoryTypes";
import { MemoryValueRepository } from "./memoryValueRepository";
import { MemoryReranker } from "./memoryReranker";

export interface RetrievalTelemetry {
    rawRetrieved: number;
    activeReturned: number;
    retrievalYield: number; // 0.0 to 1.0
}

export class LifecycleAwareRetriever implements MemoryRetriever {
    private lastTelemetry: RetrievalTelemetry | null = null;
    private reranker = new MemoryReranker();

    constructor(
        private readonly innerRetriever: MemoryRetriever,
        private readonly valueRepository: MemoryValueRepository
    ) {}

    public async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
        const requestedLimit = query.limit || 10;
        
        // 1. Apply over-fetch strategy
        const overFetchLimit = requestedLimit * 3;
        const modifiedQuery: MemoryQuery = {
            ...query,
            limit: overFetchLimit
        };

        // 2. Fetch from inner pure retriever
        const rawResults = await this.innerRetriever.retrieve(modifiedQuery);
        
        // 3. Filter dormant records
        const activeResults: MemoryRecord[] = [];
        for (const record of rawResults) {
            const metadata = await this.valueRepository.getMetadata(record.id);
            // If there's no metadata, we assume it's active (legacy/new record without metadata yet)
            if (!metadata || metadata.status === 'active') {
                activeResults.push(record);
            }
        }

        // 4. Compute yield metric
        const rawRetrieved = rawResults.length;
        const activeReturned = activeResults.length;
        const retrievalYield = rawRetrieved > 0 ? activeReturned / rawRetrieved : 1.0;

        this.lastTelemetry = {
            rawRetrieved,
            activeReturned,
            retrievalYield
        };

        if (retrievalYield < 0.5) {
            // Surface in telemetry (in a real system this would emit to a telemetry service)
            console.warn(`[Lifecycle Telemetry] Retrieval yield dropped below 50%: ${(retrievalYield * 100).toFixed(1)}%`);
        }

        // 5. Rerank and apply diversity constraints
        const rerankedResults = this.reranker.rerankAndFilter(activeResults, requestedLimit);

        // 6. Truncate back to requested limit
        return rerankedResults.slice(0, requestedLimit);
    }

    public getLastTelemetry(): RetrievalTelemetry | null {
        return this.lastTelemetry;
    }
}
