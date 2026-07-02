import { MemoryStore, MemoryRecord, MemoryQuery } from './memoryTypes';

export class InMemoryMemoryStore implements MemoryStore {
    private records: Map<string, MemoryRecord> = new Map();
    private nextId = 1;

    async create(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
        const id = `mem-${this.nextId++}`;
        const newRecord: MemoryRecord = { ...record, id };
        this.records.set(id, newRecord);
        return newRecord;
    }

    async update(record: MemoryRecord): Promise<MemoryRecord> {
        if (!this.records.has(record.id)) {
            throw new Error(`Record with id ${record.id} not found.`);
        }
        
        // Invariants: ID and provenance must be preserved across updates
        const existing = this.records.get(record.id)!;
        const updatedRecord: MemoryRecord = {
            ...record,
            id: existing.id,
            provenance: existing.provenance
        };
        
        this.records.set(record.id, updatedRecord);
        return updatedRecord;
    }

    async getById(id: string): Promise<MemoryRecord | null> {
        return this.records.get(id) || null;
    }

    async search(query: MemoryQuery): Promise<MemoryRecord[]> {
        let results = Array.from(this.records.values());

        if (query.repositoryIds && query.repositoryIds.length > 0) {
            results = results.filter(r => query.repositoryIds!.includes(r.repositoryId));
        }

        if (query.scope) {
            results = results.filter(r => r.scope === query.scope);
        }

        if (query.scopeKeys && query.scopeKeys.length > 0) {
            results = results.filter(r => 
                r.scopeKeys.some(sk => query.scopeKeys!.includes(sk))
            );
        }

        if (query.tags && query.tags.length > 0) {
            results = results.filter(r => 
                r.tags.some(t => query.tags!.includes(t))
            );
        }

        if (query.includeStale !== true) {
            results = results.filter(r => !r.stale);
        }

        // Apply textQuery simulating vector search similarity scoring
        if (query.textQuery) {
            const keywords = query.textQuery.toLowerCase().split(/\s+/);
            const scored = results.map(record => {
                let score = 0;
                const content = record.content.toLowerCase();
                const tags = record.tags.map(t => t.toLowerCase());

                keywords.forEach(kw => {
                    if (content.includes(kw)) score++;
                    if (tags.some(t => t.includes(kw))) score += 2;
                });
                return { record, score };
            });

            results = scored.filter(s => s.score > 0)
                            .sort((a, b) => b.score - a.score)
                            .map(s => s.record);
        }

        if (query.limit && query.limit > 0) {
            results = results.slice(0, query.limit);
        }

        return results;
    }

    async markStale(id: string): Promise<void> {
        const record = await this.getById(id);
        if (record) {
            record.stale = true;
            this.records.set(id, record);
        }
    }

    async archive(id: string): Promise<void> {
        this.records.delete(id);
    }

    async delete(id: string): Promise<void> {
        this.records.delete(id);
    }
}
