export interface MemoryRecord {
    id: string;
    externalId?: string;
    repositoryId: string;
    content: string;
    scope: string;       // e.g. 'repository', 'file', 'symbol', 'mentor'
    scopeKeys: string[]; // Specific identifiers for the scope (e.g. file paths, symbol names)
    tags: string[];      // Taxonomy or functional tags
    stale: boolean;
    distance?: number;   // LanceDB _distance
    confidence?: number; // Added for retrieval V2
    provenance: {
        authorType: string;
        timestamp: string;
    };
}

export interface MemoryQuery {
    repositoryIds?: string[];
    externalId?: string;
    scope?: string;
    scopeKeys?: string[];
    tags?: string[];
    includeStale?: boolean;
    limit?: number;
    textQuery?: string;
}

export interface MemoryStore {
    create(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord>;
    update(record: MemoryRecord): Promise<MemoryRecord>;
    getById(id: string): Promise<MemoryRecord | null>;
    search(query: MemoryQuery): Promise<MemoryRecord[]>;
    markStale(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    delete(id: string): Promise<void>;
}

export interface MemoryRetriever {
    retrieve(query: MemoryQuery): Promise<MemoryRecord[]>;
}

export interface MemoryContext {
    memories: Array<{
        content: string;
        scope: string;
        tags: string[];
        stale: boolean;
        provenance: {
            authorType: string;
            timestamp: string;
        }
    }>;
    retrievalMetadata: {
        originalQuery: string;
        timestamp: string;
        totalRetrieved: number;
    };
}
