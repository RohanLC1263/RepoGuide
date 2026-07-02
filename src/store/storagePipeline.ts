import { LogicalUnit } from '../indexing/logicalUnitTypes';
import { FactRecord } from '../indexing/factTypes';
import { EntityRegistryStore } from '../registry/entityRegistryStore';
import { UUIDResolver } from '../registry/uuidResolver';
import { LogicalUnitStore } from './logicalUnitStore';
import { FactStore } from './factStore';

export class StoragePipeline {
    private registry: EntityRegistryStore;
    private resolver: UUIDResolver;
    private initialized = false;
    
    // UUID inheritance cache: maps unit legacy id -> resolved uuid
    // Flushed per-file (or per-batch) to prevent unbound memory growth.
    private uuidCache = new Map<string, string>();

    constructor(
        private repoguideDir: string,
        private unitStore: LogicalUnitStore,
        private factStore: FactStore
    ) {
        this.registry = new EntityRegistryStore(this.repoguideDir);
        this.resolver = new UUIDResolver(this.registry);
    }

    async init(repoRoot: string): Promise<void> {
        if (this.initialized) return;
        await this.unitStore.init(repoRoot);
        await this.factStore.init(repoRoot);
        await this.registry.init(repoRoot);
        this.initialized = true;
    }

    async upsertUnits(units: LogicalUnit[]): Promise<void> {
        if (!this.initialized) throw new Error('StoragePipeline not initialized');
        
        // Clear cache for new batch (typically one file's worth of units)
        this.uuidCache.clear();

        for (const unit of units) {
            if (unit.requires_identity) {
                const sig = {
                    filePath: unit.filePath,
                    symbol: unit.symbol,
                    type: unit.type
                };
                const uuid = this.resolver.resolveUUID(sig);
                unit.uuid = uuid;
                this.uuidCache.set(unit.id, uuid);
            }
        }
        
        // Pass to raw store
        await this.unitStore.internalUpsertUnits(units);
    }

    async upsertFacts(facts: FactRecord[]): Promise<void> {
        if (!this.initialized) throw new Error('StoragePipeline not initialized');

        for (const fact of facts) {
            if (fact.unitId) {
                const mappedUuid = this.uuidCache.get(fact.unitId);
                if (mappedUuid) {
                    fact.subjectUuid = mappedUuid;
                } else {
                    // Cache miss implies it was ephemeral, cross-file, or failed mapping.
                    // Do not reconstruct signature or query registry.
                    console.warn(`[Checkpoint-B] UUID cache miss`, { unitId: fact.unitId });
                }
            }
        }
        
        // Pass to raw store
        await this.factStore.internalUpsertFacts(facts);
    }

    async deleteFile(filePath: string): Promise<void> {
        if (!this.initialized) throw new Error('StoragePipeline not initialized');
        await this.unitStore.deleteFile(filePath);
        await this.factStore.deleteFile(filePath);
    }
    
    async clearAll(): Promise<void> {
        if (!this.initialized) throw new Error('StoragePipeline not initialized');
        await this.unitStore.clearAll();
        await this.factStore.clearAll();
    }

    getUnitStore(): LogicalUnitStore {
        return this.unitStore;
    }

    getFactStore(): FactStore {
        return this.factStore;
    }
}
