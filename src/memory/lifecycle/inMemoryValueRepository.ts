import { MemoryLifecycleMetadata, MemoryValueRepository } from "./memoryValueRepository";

export class InMemoryValueRepository implements MemoryValueRepository {
    private records: Map<string, MemoryLifecycleMetadata> = new Map();

    public async upsert(metadata: MemoryLifecycleMetadata): Promise<void> {
        this.records.set(metadata.memoryId, metadata);
    }

    public async getMetadata(memoryId: string): Promise<MemoryLifecycleMetadata | null> {
        return this.records.get(memoryId) || null;
    }

    public async getAllActiveMetadata(repositoryId: string): Promise<MemoryLifecycleMetadata[]> {
        const results: MemoryLifecycleMetadata[] = [];
        for (const record of this.records.values()) {
            if (record.repositoryId === repositoryId && record.status === 'active') {
                results.push(record);
            }
        }
        return results;
    }

    public async markDormant(memoryId: string): Promise<void> {
        const record = this.records.get(memoryId);
        if (record) {
            record.status = 'dormant';
        }
    }

    public async markActive(memoryId: string): Promise<void> {
        const record = this.records.get(memoryId);
        if (record) {
            record.status = 'active';
        }
    }
}
