import * as lancedb from 'vectordb';
import { MemoryStore, MemoryRecord, MemoryQuery } from './memoryTypes';
import { EmbeddingProvider } from './embeddings/embeddingProvider';
import { MemoryRowMapper, LanceRow } from './storage/memoryRowMapper';
import * as path from 'path';
import * as fs from 'fs';

export class LanceDbMemoryStore implements MemoryStore {
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;
    private tableName = 'memory_records';
    private mapper = new MemoryRowMapper();

    constructor(
        private embeddingProvider: EmbeddingProvider,
        private dbPath: string = path.join('.repoguide', 'lancedb_memory')
    ) {
        if (!fs.existsSync(this.dbPath)) {
            fs.mkdirSync(this.dbPath, { recursive: true });
        }
    }

    async initialize() {
        if (!this.db) {
            this.db = await lancedb.connect(this.dbPath);
            try {
                this.table = await this.db.openTable(this.tableName);
            } catch (err) {
                // Table doesn't exist yet, we will create it on first insert
            }
        }
    }

    private async ensureTable(initialData: LanceRow[]) {
        if (!this.db) await this.initialize();
        if (!this.table) {
            this.table = await this.db!.createTable(this.tableName, initialData);
        } else {
            await this.table.add(initialData);
        }
    }

    async create(record: Omit<MemoryRecord, 'id'>): Promise<MemoryRecord> {
        await this.initialize();
        const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const newRecord: MemoryRecord = { ...record, id };
        
        const vector = await this.embeddingProvider.embed(newRecord.content);
        const row = this.mapper.toRow(newRecord, vector);
        
        await this.ensureTable([row]);
        return newRecord;
    }

    async update(record: MemoryRecord): Promise<MemoryRecord> {
        await this.initialize();
        if (!this.table) throw new Error("Table not initialized");
        
        await this.table.delete(`id = '${record.id}'`);
        
        const vector = await this.embeddingProvider.embed(record.content);
        const row = this.mapper.toRow(record, vector);
        await this.ensureTable([row]);
        
        return record;
    }

    async getById(id: string): Promise<MemoryRecord | null> {
        await this.initialize();
        if (!this.table) return null;
        
        const results = await this.table.search(new Array(384).fill(0))
            .filter(`id = '${id}'`)
            .limit(1)
            .execute<LanceRow>();
            
        if (results && results.length > 0) {
            return this.mapper.fromRow(results[0]);
        }
        return null;
    }

    async search(query: MemoryQuery): Promise<MemoryRecord[]> {
        await this.initialize();
        if (!this.table) return [];

        let vector: number[] = new Array(384).fill(0);
        let useSemanticSearch = false;
        
        if (query.textQuery) {
            vector = await this.embeddingProvider.embed(query.textQuery);
            useSemanticSearch = true;
        }

        let lancedbQuery = this.table.search(vector);

        let filters: string[] = [];

        if (query.repositoryIds && query.repositoryIds.length > 0) {
            const listStr = query.repositoryIds.map((id: string) => `'${id}'`).join(', ');
            filters.push(`\`repositoryId\` IN (${listStr})`);
        }

        if (query.externalId) {
            filters.push(`externalId = '${query.externalId}'`);
        }

        if (query.scope) {
            filters.push(`scope = '${query.scope}'`);
        }

        if (query.includeStale !== true) {
            filters.push(`stale = false`);
        }

        if (filters.length > 0) {
            lancedbQuery = lancedbQuery.filter(filters.join(' AND '));
        }

        lancedbQuery = lancedbQuery.limit(useSemanticSearch ? 100 : 1000);

        const rawResults = await lancedbQuery.execute<LanceRow>();
        let parsedResults = rawResults.map(r => this.mapper.fromRow(r));

        if (query.scopeKeys && query.scopeKeys.length > 0) {
            parsedResults = parsedResults.filter(r => 
                r.scopeKeys.some((sk: string) => query.scopeKeys!.includes(sk))
            );
        }

        if (query.tags && query.tags.length > 0) {
            parsedResults = parsedResults.filter(r => 
                r.tags.some((t: string) => query.tags!.includes(t))
            );
        }

        if (query.limit) {
            parsedResults = parsedResults.slice(0, query.limit);
        }

        return parsedResults;
    }

    async markStale(id: string): Promise<void> {
        const record = await this.getById(id);
        if (record) {
            record.stale = true;
            await this.update(record);
        }
    }

    async archive(id: string): Promise<void> {
        await this.delete(id);
    }

    async delete(id: string): Promise<void> {
        await this.initialize();
        if (this.table) {
            await this.table.delete(`id = '${id}'`);
        }
    }
}
