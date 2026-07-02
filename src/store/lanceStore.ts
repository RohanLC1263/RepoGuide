import * as lancedb from 'vectordb';
import { CodeChunk } from './storeTypes';

function safeStringLiteral(value: string): string {
    // Escape SQL string delimiters and strip control characters.
    // Backslashes are literal path characters in Lance SQL filters.
    return value
        .replace(/'/g, "''")
        .replace(/[\x00-\x1f]/g, '');  // strip control chars
}

function filePathFilter(filePath: string): string {
    return `\`filePath\` = '${safeStringLiteral(filePath)}'`;
}

function idFilter(id: string): string {
    return `\`id\` = '${safeStringLiteral(id)}'`;
}

export class LanceStore {
    private dbPath: string;
    private db: lancedb.Connection | null = null;
    private table: lancedb.Table | null = null;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
    }

    async init(): Promise<void> {
        this.db = await lancedb.connect(this.dbPath);
        try {
            this.table = await this.db.openTable('chunks');
        } catch (e) {
            // Table doesn't exist, create it with a sample record
            const sample: CodeChunk = {
                id: 'dummy',
                filePath: 'dummy',
                language: 'dummy',
                startLine: 0,
                endLine: 0,
                text: 'dummy',
                vector: new Array(768).fill(0),
                hash: 'dummy'
            };
            this.table = await this.db.createTable('chunks', [sample as unknown as Record<string, unknown>]);
            await this.deleteChunkById('dummy');
        }
    }

    async insertChunks(chunks: CodeChunk[]): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        if (chunks.length === 0) {
            return;
        }
        await this.table.add(chunks as unknown as Record<string, unknown>[]);
    }

    async deleteChunksByFile(filePath: string): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        await this.table.delete(filePathFilter(filePath));
    }

    async getChunksByFile(filePath: string): Promise<CodeChunk[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        const results = await this.table.filter(filePathFilter(filePath)).execute();
        if (results.length > 0) {
            return results as unknown as CodeChunk[];
        }

        const normalizedTarget = normalizeFilePath(filePath);
        const allChunks = await this.getAllChunks();
        return allChunks.filter(chunk => normalizeFilePath(chunk.filePath) === normalizedTarget);
    }

    async queryByVector(vector: number[], topK: number): Promise<CodeChunk[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        const results = await this.table.search(vector).metricType('cosine' as any).limit(topK).execute();
        return results as unknown as CodeChunk[];
    }

    async getAllFilePaths(): Promise<string[]> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }
            const results = await this.table.filter('\`startLine\` >= 0')
                .select(['filePath'])
                .limit(count + 100)
                .execute();
            const paths = new Set<string>();
            for (const row of results) {
                if (row.filePath && row.filePath !== 'dummy') {
                    paths.add(row.filePath as string);
                }
            }
            return Array.from(paths);
        } catch {
            return [];
        }
    }

    async deleteChunkById(id: string): Promise<void> {
        if (!this.table) {
            throw new Error('Table not initialized');
        }
        await this.table.delete(idFilter(id));
    }

    async clearAll(): Promise<void> {
        if (this.db) {
            try {
                await this.db.dropTable('chunks');
            } catch (e) {
                // Table might not exist
            }
            this.table = null;
            await this.init();
        }
    }

    async getChunkCount(): Promise<number> {
        if (!this.table) {
            return 0;
        }
        try {
            return await this.table.countRows();
        } catch {
            const results = await this.table.filter('\`startLine\` >= 0').execute();
            return results.length;
        }
    }

    async getAllChunks(): Promise<CodeChunk[]> {
        if (!this.table) {
            return [];
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }
            const results = await this.table
                .filter('\`startLine\` >= 0')
                .limit(count + 1000)
                .execute() as unknown as CodeChunk[];
            return results.filter(chunk => chunk.id !== 'dummy');
        } catch {
            return [];
        }
    }

    async searchByKeywords(keywords: string[]): Promise<CodeChunk[]> {
        if (!this.table || keywords.length === 0) {
            return [];
        }
        try {
            const count = await this.table.countRows();
            if (count === 0) {
                return [];
            }

            const conditions = keywords.map(kw => 
                `(LOWER(\`text\`) LIKE '%${kw.toLowerCase().replace(/'/g, "''")}%' OR LOWER(\`filePath\`) LIKE '%${kw.toLowerCase().replace(/'/g, "''")}%')`
            ).join(' OR ');

            const results = await this.table
                .filter(conditions)
                .limit(50)
                .execute() as unknown as CodeChunk[];

            return results.filter(chunk => chunk.id !== 'dummy');
        } catch {
            return [];
        }
    }
}

function normalizeFilePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}
