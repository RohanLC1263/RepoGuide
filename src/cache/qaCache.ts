import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../context/repositoryContext';
import { openDatabase } from '../store/sqliteLoader';

export interface QAPair {
    id: number;
    question: string;
    answer: string;
    filePath: string;
    startLine: number;
    endLine: number;
    symbolName: string;
    questionEmbedding: number[];
    generatedAt: string;
    category?: string;
    sourceModule?: string;
    answerQuality?: number;
    hitCount?: number;
    lastAccessed?: string;
}

export interface CacheIndexEntry {
    id: number;
    embedding: number[];
    category?: string;
}

interface DatabaseStatement {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
}

interface DatabaseConnection {
    exec(source: string): unknown;
    prepare(source: string): DatabaseStatement;
    close(): void;
}

type DatabaseConstructor = new (filename: string) => DatabaseConnection;

interface QARow {
    id: number;
    question: string;
    answer: string;
    file_path: string;
    start_line: number;
    end_line: number;
    symbol_name: string;
    question_embedding: Buffer;
    generated_at: string;
    category?: string | null;
    source_module?: string | null;
    answer_quality?: number | null;
    hit_count?: number | null;
    last_accessed?: string | null;
}

interface ColumnInfoRow {
    name: string;
}

export class QACache {
    private db: DatabaseConnection | null = null;
    private disabledReason: string | null = null;
    private searchIndex: CacheIndexEntry[] = [];

    constructor(private repoguideDir: string, private logger?: Logger) {}

    init(): boolean {
        if (this.db) {
            return true;
        }

        const dbPath = path.join(this.repoguideDir, 'qa_cache.db');
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        try {
            this.db = openDatabase(dbPath) as unknown as DatabaseConnection;
            this.db.exec('PRAGMA journal_mode = WAL');

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS qa_pairs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    symbol_name TEXT NOT NULL,
                    question_embedding BLOB NOT NULL,
                    generated_at TEXT NOT NULL,
                    category TEXT,
                    source_module TEXT,
                    answer_quality REAL NOT NULL DEFAULT 0.5,
                    hit_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed TEXT,
                    UNIQUE(question, file_path, start_line, symbol_name)
                );
                CREATE INDEX IF NOT EXISTS idx_qa_symbol ON qa_pairs(symbol_name);
                CREATE INDEX IF NOT EXISTS idx_qa_file ON qa_pairs(file_path);
            `);
            this.migrateSchema();
            this.rebuildIndex();
            this.disabledReason = null;
            return true;
        } catch (error) {
            this.db = null;
            this.disabledReason = `Q&A cache disabled: ${error instanceof Error ? error.message : String(error)}`;
            this.logger?.error(`Failed to initialize Q&A cache: ${error}`);
            return false;
        }
    }

    insert(pair: Omit<QAPair, 'id'>): void {
        if (!this.db) {
            return;
        }

        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO qa_pairs
            (
                question,
                answer,
                file_path,
                start_line,
                end_line,
                symbol_name,
                question_embedding,
                generated_at,
                category,
                source_module,
                answer_quality,
                hit_count,
                last_accessed
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const embeddingBuffer = Buffer.from(new Float32Array(pair.questionEmbedding).buffer);
        stmt.run(
            pair.question,
            pair.answer,
            pair.filePath,
            pair.startLine,
            pair.endLine,
            pair.symbolName,
            embeddingBuffer,
            pair.generatedAt,
            pair.category ?? null,
            pair.sourceModule ?? null,
            pair.answerQuality ?? 0.5,
            pair.hitCount ?? 0,
            pair.lastAccessed ?? null
        );
        this.rebuildIndex();
    }

    getAll(): QAPair[] {
        if (!this.db) {
            return [];
        }

        const rows = this.db.prepare('SELECT * FROM qa_pairs').all() as QARow[];
        return rows.map(row => ({
            id: row.id,
            question: row.question,
            answer: row.answer,
            filePath: row.file_path,
            startLine: row.start_line,
            endLine: row.end_line,
            symbolName: row.symbol_name,
            questionEmbedding: this.decodeEmbedding(row.question_embedding),
            generatedAt: row.generated_at,
            category: row.category ?? undefined,
            sourceModule: row.source_module ?? undefined,
            answerQuality: typeof row.answer_quality === 'number' ? row.answer_quality : 0.5,
            hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
            lastAccessed: row.last_accessed ?? undefined
        }));
    }

    deleteByFile(filePath: string): void {
        if (!this.db) {
            return;
        }
        this.db.prepare('DELETE FROM qa_pairs WHERE file_path = ?').run(filePath);
        this.rebuildIndex();
    }

    deleteBySymbol(symbolName: string): void {
        if (!this.db) {
            return;
        }
        this.db.prepare('DELETE FROM qa_pairs WHERE symbol_name = ?').run(symbolName);
        this.rebuildIndex();
    }

    clear(): void {
        if (!this.db) {
            return;
        }
        this.db.prepare('DELETE FROM qa_pairs').run();
        this.rebuildIndex();
    }

    getCount(): number {
        if (!this.db) {
            return 0;
        }
        const row = this.db.prepare('SELECT COUNT(*) as count FROM qa_pairs').get() as { count: number };
        return row.count;
    }

    updateQuality(id: number, delta: number): void {
        if (!this.db) {
            return;
        }

        this.db.prepare(`
            UPDATE qa_pairs
            SET answer_quality = MIN(1.0, MAX(0.0, COALESCE(answer_quality, 0.5) + ?))
            WHERE id = ?
        `).run(delta, id);
    }

    incrementHitCount(id: number): void {
        if (!this.db) {
            return;
        }

        this.db.prepare(`
            UPDATE qa_pairs
            SET hit_count = COALESCE(hit_count, 0) + 1,
                last_accessed = ?
            WHERE id = ?
        `).run(new Date().toISOString(), id);
    }

    getStaleIds(): number[] {
        if (!this.db) {
            return [];
        }

        const rows = this.db.prepare(`
            SELECT id
            FROM qa_pairs
            WHERE COALESCE(answer_quality, 0.5) <= 0.25
        `).all() as Array<{ id: number }>;

        return rows.map(row => row.id);
    }

    close(): void {
        this.db?.close();
        this.db = null;
        this.searchIndex = [];
    }

    getSearchIndex(): CacheIndexEntry[] {
        return this.searchIndex;
    }

    getById(id: number): QAPair | null {
        if (!this.db) {
            return null;
        }

        const row = this.db.prepare('SELECT * FROM qa_pairs WHERE id = ?').get(id) as QARow | undefined;
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            question: row.question,
            answer: row.answer,
            filePath: row.file_path,
            startLine: row.start_line,
            endLine: row.end_line,
            symbolName: row.symbol_name,
            questionEmbedding: this.decodeEmbedding(row.question_embedding),
            generatedAt: row.generated_at,
            category: row.category ?? undefined,
            sourceModule: row.source_module ?? undefined,
            answerQuality: typeof row.answer_quality === 'number' ? row.answer_quality : 0.5,
            hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
            lastAccessed: row.last_accessed ?? undefined
        };
    }

    private rebuildIndex(): void {
        if (!this.db) {
            this.searchIndex = [];
            return;
        }

        const rows = this.db.prepare('SELECT id, question_embedding, category FROM qa_pairs').all() as Array<{
            id: number;
            question_embedding: Buffer;
            category: string | null;
        }>;

        this.searchIndex = rows.map(row => ({
            id: row.id,
            embedding: this.decodeEmbedding(row.question_embedding),
            category: row.category ?? undefined
        }));
    }

    isAvailable(): boolean {
        return this.db !== null;
    }

    getDisabledReason(): string | null {
        return this.disabledReason;
    }

    private decodeEmbedding(blob: Buffer): number[] {
        const arrayBuffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return Array.from(new Float32Array(arrayBuffer));
    }

    private migrateSchema(): void {
        if (!this.db) {
            return;
        }

        const existingColumns = new Set(
            (this.db.prepare('PRAGMA table_info(qa_pairs)').all() as ColumnInfoRow[])
                .map(column => column.name)
        );

        const migrations: Array<{ name: string; sql: string }> = [
            { name: 'category', sql: 'ALTER TABLE qa_pairs ADD COLUMN category TEXT' },
            { name: 'source_module', sql: 'ALTER TABLE qa_pairs ADD COLUMN source_module TEXT' },
            { name: 'answer_quality', sql: 'ALTER TABLE qa_pairs ADD COLUMN answer_quality REAL NOT NULL DEFAULT 0.5' },
            { name: 'hit_count', sql: 'ALTER TABLE qa_pairs ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0' },
            { name: 'last_accessed', sql: 'ALTER TABLE qa_pairs ADD COLUMN last_accessed TEXT' }
        ];

        for (const migration of migrations) {
            if (!existingColumns.has(migration.name)) {
                this.db.exec(migration.sql);
            }
        }
    }
}

