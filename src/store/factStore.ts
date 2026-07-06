import * as fs from 'fs/promises';
import * as path from 'path';
import { openDatabase, Database, executeTransaction } from './sqliteLoader';
import { normalizeFilePathForLookup } from './pathNormalization';
import { FactRecord, FactQuery, FactType } from '../indexing/factTypes';

export class FactStore {
    private db: Database | null = null;
    private dbPath = '';

    constructor(private repoguideDir?: string) {}

    async init(repoRoot: string): Promise<void> {
        const baseDir = this.repoguideDir ?? path.join(repoRoot, '.repoguide');
        this.dbPath = path.join(baseDir, 'facts.db');
        
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        
        this.db = openDatabase(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS facts (
                factId TEXT PRIMARY KEY,
                filePath TEXT NOT NULL,
                unitId TEXT NOT NULL,
                subject_uuid TEXT,
                object_uuid TEXT,
                symbol TEXT,
                factType TEXT NOT NULL,
                value TEXT NOT NULL,
                valueKind TEXT NOT NULL,
                startLine INTEGER NOT NULL,
                endLine INTEGER NOT NULL,
                extractionMethod TEXT NOT NULL,
                confidence TEXT NOT NULL,
                sourceText TEXT NOT NULL,
                role TEXT NOT NULL,
                diagnostics TEXT
            );
            
            CREATE INDEX IF NOT EXISTS idx_fact_filePath ON facts(filePath);
            CREATE INDEX IF NOT EXISTS idx_fact_symbol ON facts(symbol);
            CREATE INDEX IF NOT EXISTS idx_fact_type ON facts(factType);
            CREATE INDEX IF NOT EXISTS idx_fact_role ON facts(role);
        `);

        try {
            this.db.exec('ALTER TABLE facts ADD COLUMN subject_uuid TEXT;');
            this.db.exec('ALTER TABLE facts ADD COLUMN object_uuid TEXT;');
        } catch (e) {
            // Ignore if columns already exist
        }

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_facts_subject_uuid ON facts(subject_uuid);
            CREATE INDEX IF NOT EXISTS idx_facts_object_uuid ON facts(object_uuid);
        `);
    }

    // Alias for tests
    async upsertFacts(facts: FactRecord[]): Promise<void> {
        return this.internalUpsertFacts(facts);
    }

    async internalUpsertFacts(facts: FactRecord[]): Promise<void> {
        if (facts.length === 0) {
            return;
        }
        this.assertInitialized();

        const touchedFiles = Array.from(new Set(facts.map(f => normalizeFilePathForLookup(f.filePath))));

        const deleteStmt = this.db!.prepare('DELETE FROM facts WHERE lower(filePath) = ?');
        const insertStmt = this.db!.prepare(`
            INSERT INTO facts (
                factId, filePath, unitId, subject_uuid, object_uuid, symbol, factType, value, valueKind,
                startLine, endLine, extractionMethod, confidence, sourceText,
                role, diagnostics
            ) VALUES (
                @factId, @filePath, @unitId, @subjectUuid, @objectUuid, @symbol, @factType, @value, @valueKind,
                @startLine, @endLine, @extractionMethod, @confidence, @sourceText,
                @role, @diagnostics
            )
        `);

        const transaction = executeTransaction(this.db!, (filesToDelete: string[], factsToInsert: FactRecord[]) => {
            for (const file of filesToDelete) {
                deleteStmt.run(file);
            }
            for (const fact of factsToInsert) {
                const row = {
                    factId: fact.factId,
                    filePath: fact.filePath.replace(/\\/g, '/'),
                    unitId: fact.unitId,
                    subjectUuid: fact.subjectUuid ?? null,
                    objectUuid: fact.objectUuid ?? null,
                    symbol: fact.symbol ?? null,
                    factType: fact.factType,
                    value: serializeValue(fact.value),
                    valueKind: fact.valueKind,
                    startLine: fact.startLine,
                    endLine: fact.endLine,
                    extractionMethod: fact.extractionMethod,
                    confidence: fact.confidence,
                    sourceText: fact.sourceText,
                    role: fact.role,
                    diagnostics: fact.diagnostics ?? null
                };
                insertStmt.run(row);
            }
        });

        transaction(touchedFiles, facts);
    }

    async deleteFile(filePath: string): Promise<void> {
        this.assertInitialized();
        const normalizedTarget = normalizeFilePathForLookup(filePath);
        const stmt = this.db!.prepare('DELETE FROM facts WHERE lower(filePath) = ?');
        stmt.run(normalizedTarget);
    }

    async clearAll(): Promise<void> {
        this.assertInitialized();
        this.db!.exec('DELETE FROM facts');
    }

    async getFact(factId: string): Promise<FactRecord | undefined> {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT * FROM facts WHERE factId = ?');
        const row = stmt.get(factId) as any;
        if (!row) return undefined;
        return mapRowToFact(row);
    }

    async findBySymbol(symbol: string, options: FactQuery = {}): Promise<FactRecord[]> {
        return this.queryFacts({ ...options, symbol });
    }

    async findByType(factType: FactType, options: FactQuery = {}): Promise<FactRecord[]> {
        return this.queryFacts({ ...options, factType });
    }

    async findExactValue(value: unknown, options: FactQuery = {}): Promise<FactRecord[]> {
        return this.queryFacts({ ...options, value });
    }

    async queryFacts(query: FactQuery): Promise<FactRecord[]> {
        this.assertInitialized();
        
        let sql = 'SELECT * FROM facts WHERE 1=1';
        const params: any[] = [];

        if (query.factType) {
            sql += ' AND factType = ?';
            params.push(query.factType);
        }
        if (query.symbol) {
            sql += " AND (symbol = ? OR (factType = 'instantiation' AND value LIKE ?))";
            params.push(query.symbol, `%"instantiatedClass":"${query.symbol}"%`);
        }
        if (query.filePath) {
            sql += ' AND lower(filePath) = ?';
            params.push(normalizeFilePathForLookup(query.filePath));
        }
        if (query.value !== undefined) {
            sql += ' AND value = ?';
            params.push(serializeValue(query.value));
        }
        if (query.confidence) {
            sql += ' AND confidence = ?';
            params.push(query.confidence);
        }
        if (query.role) {
            sql += ' AND role = ?';
            params.push(query.role);
        }
        if (query.excludeRoles && query.excludeRoles.length > 0) {
            const placeholders = query.excludeRoles.map(() => '?').join(',');
            sql += ` AND role NOT IN (${placeholders})`;
            params.push(...query.excludeRoles);
        }

        // Add a case statement in ORDER BY to ensure High > Medium > Low
        sql += ` ORDER BY 
                 CASE confidence 
                    WHEN 'high' THEN 1 
                    WHEN 'medium' THEN 2 
                    WHEN 'low' THEN 3 
                    ELSE 4 
                 END ASC, 
                 filePath ASC, startLine ASC`;
                 
        if (query.limit !== undefined && query.limit !== Number.POSITIVE_INFINITY) {
            sql += ' LIMIT ?';
            params.push(query.limit);
        }

        const stmt = this.db!.prepare(sql);
        const rows = stmt.all(...params) as any[];
        return rows.map(mapRowToFact);
    }

    private assertInitialized(): void {
        if (!this.db) {
            throw new Error('FactStore is not initialized');
        }
    }
}

function serializeValue(val: unknown): string {
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
}

function parseValue(valStr: string, kind: string): unknown {
    if (kind === 'string') return valStr;
    try {
        return JSON.parse(valStr);
    } catch {
        return valStr;
    }
}

function mapRowToFact(row: any): FactRecord {
    return {
        factId: row.factId,
        filePath: row.filePath,
        unitId: row.unitId,
        subjectUuid: row.subject_uuid ?? undefined,
        objectUuid: row.object_uuid ?? undefined,
        symbol: row.symbol ?? undefined,
        factType: row.factType,
        value: parseValue(row.value, row.valueKind),
        valueKind: row.valueKind,
        startLine: row.startLine,
        endLine: row.endLine,
        extractionMethod: row.extractionMethod,
        confidence: row.confidence,
        sourceText: row.sourceText,
        role: row.role,
        diagnostics: row.diagnostics ?? undefined
    };
}
