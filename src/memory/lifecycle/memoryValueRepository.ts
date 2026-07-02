export interface MemoryLifecycleMetadata {
    memoryId: string;
    repositoryId: string;
    confidence: number;
    usageFrequency: number;
    impactScore: number;
    recencyScore: number;
    humanWeight: number;
    valueScore: number;
    status: 'active' | 'dormant';
}

export interface MemoryValueRepository {
    upsert(metadata: MemoryLifecycleMetadata): Promise<void>;
    getMetadata(memoryId: string): Promise<MemoryLifecycleMetadata | null>;
    getAllActiveMetadata(repositoryId: string): Promise<MemoryLifecycleMetadata[]>;
    markDormant(memoryId: string): Promise<void>;
    markActive(memoryId: string): Promise<void>;
}
