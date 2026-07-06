import * as fs from 'fs/promises';
import * as path from 'path';
import { openDatabase, Database, executeTransaction } from './sqliteLoader';
import { normalizeFilePathForLookup } from './pathNormalization';
import {
    LogicalUnit,
    LogicalUnitIndex,
    LogicalUnitRole,
    LogicalUnitType
} from '../indexing/logicalUnitTypes';

interface SearchOptions {
    role?: LogicalUnitRole;
    types?: LogicalUnitType[];
    limit?: number;
}

interface ContentSearchOptions {
    role?: LogicalUnitRole;
    excludeRoles?: LogicalUnitRole[];
    limit?: number;
}

export class LogicalUnitStore {
    private db: Database | null = null;
    private dbPath = '';

    constructor(private repoguideDir?: string) {}

    async init(repoRoot: string): Promise<void> {
        const baseDir = this.repoguideDir ?? path.join(repoRoot, '.repoguide');
        this.dbPath = path.join(baseDir, 'logical_units.db');
        
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        
        this.db = openDatabase(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS logical_units (
                id TEXT PRIMARY KEY,
                uuid TEXT,
                type TEXT NOT NULL,
                symbol TEXT,
                filePath TEXT NOT NULL,
                language TEXT NOT NULL,
                startLine INTEGER NOT NULL,
                endLine INTEGER NOT NULL,
                content TEXT NOT NULL,
                parentUnitId TEXT,
                parentSymbol TEXT,
                role TEXT NOT NULL,
                parseStatus TEXT NOT NULL,
                extractionMethod TEXT NOT NULL,
                metadata TEXT NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_filePath ON logical_units(filePath);
            CREATE INDEX IF NOT EXISTS idx_symbol ON logical_units(symbol);
            CREATE INDEX IF NOT EXISTS idx_role ON logical_units(role);
        `);
        
        try {
            this.db.exec('ALTER TABLE logical_units ADD COLUMN uuid TEXT;');
        } catch (e) {
            // Ignore if column already exists
        }

        this.db.exec('CREATE INDEX IF NOT EXISTS idx_logical_units_uuid ON logical_units(uuid);');
    }

    // Alias for tests
    async upsertUnits(units: LogicalUnit[]): Promise<void> {
        return this.internalUpsertUnits(units);
    }

    async internalUpsertUnits(units: LogicalUnit[]): Promise<void> {
        if (units.length === 0) {
            return;
        }
        this.assertInitialized();

        const touchedFiles = Array.from(new Set(units.map(unit => normalizeFilePathForLookup(unit.filePath))));

        const deleteStmt = this.db!.prepare('DELETE FROM logical_units WHERE lower(filePath) = ?');
        const insertStmt = this.db!.prepare(`
            INSERT INTO logical_units (
                id, uuid, type, symbol, filePath, language, startLine, endLine, 
                content, parentUnitId, parentSymbol, role, parseStatus, 
                extractionMethod, metadata
            ) VALUES (
                @id, @uuid, @type, @symbol, @filePath, @language, @startLine, @endLine, 
                @content, @parentUnitId, @parentSymbol, @role, @parseStatus, 
                @extractionMethod, @metadata
            )
        `);

        const transaction = executeTransaction(this.db!, (filesToDelete: string[], unitsToInsert: LogicalUnit[]) => {
            for (const file of filesToDelete) {
                deleteStmt.run(file);
            }
            for (const unit of unitsToInsert) {
                const row = {
                    id: unit.id,
                    uuid: unit.uuid ?? null,
                    type: unit.type,
                    symbol: unit.symbol ?? null,
                    filePath: unit.filePath.replace(/\\/g, '/'),
                    language: unit.language,
                    startLine: unit.startLine,
                    endLine: unit.endLine,
                    content: unit.content,
                    parentUnitId: unit.parentUnitId ?? null,
                    parentSymbol: unit.parentSymbol ?? null,
                    role: unit.role,
                    parseStatus: unit.parseStatus,
                    extractionMethod: unit.extractionMethod,
                    metadata: JSON.stringify(unit.metadata)
                };
                insertStmt.run(row);
            }
        });

        transaction(touchedFiles, units);
    }

    async deleteFile(filePath: string): Promise<void> {
        this.assertInitialized();
        const normalizedTarget = normalizeFilePathForLookup(filePath);
        const stmt = this.db!.prepare('DELETE FROM logical_units WHERE lower(filePath) = ?');
        stmt.run(normalizedTarget);
    }

    async clearAll(): Promise<void> {
        this.assertInitialized();
        this.db!.exec('DELETE FROM logical_units');
    }

    async getUnit(id: string): Promise<LogicalUnit | undefined> {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT * FROM logical_units WHERE id = ?');
        const row = stmt.get(id) as any;
        if (!row) return undefined;
        return mapRowToUnit(row);
    }

    async getUnitsByFile(filePath: string): Promise<LogicalUnit[]> {
        this.assertInitialized();
        const normalizedTarget = normalizeFilePathForLookup(filePath);
        const stmt = this.db!.prepare('SELECT * FROM logical_units WHERE lower(filePath) = ? ORDER BY startLine ASC');
        const rows = stmt.all(normalizedTarget) as any[];
        return rows.map(mapRowToUnit);
    }

    async getAll(): Promise<LogicalUnit[]> {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT * FROM logical_units');
        const rows = stmt.all() as any[];
        return rows.map(mapRowToUnit);
    }

    async searchBySymbol(symbol: string, options: SearchOptions = {}): Promise<LogicalUnitIndex[]> {
        this.assertInitialized();
        const normalizedSymbol = symbol.toLowerCase();
        
        let query = 'SELECT id, type, symbol, filePath, language, startLine, endLine, role, parseStatus FROM logical_units WHERE lower(symbol) = ?';
        const params: any[] = [normalizedSymbol];

        if (options.role) {
            query += ' AND role = ?';
            params.push(options.role);
        }

        if (options.types && options.types.length > 0) {
            const placeholders = options.types.map(() => '?').join(',');
            query += ` AND type IN (${placeholders})`;
            params.push(...options.types);
        }

        query += ' ORDER BY filePath ASC, startLine ASC LIMIT ?';
        params.push(options.limit ?? 20);

        const stmt = this.db!.prepare(query);
        const rows = stmt.all(...params) as any[];
        return rows.map(mapRowToIndex);
    }

    async searchByContent(queryText: string, options: ContentSearchOptions = {}): Promise<LogicalUnitIndex[]> {
        this.assertInitialized();
        const terms = tokenize(queryText);
        if (terms.length === 0) {
            return [];
        }

        let query = 'SELECT * FROM logical_units WHERE 1=1';
        const params: any[] = [];

        if (options.role) {
            query += ' AND role = ?';
            params.push(options.role);
        }

        if (options.excludeRoles && options.excludeRoles.length > 0) {
            const placeholders = options.excludeRoles.map(() => '?').join(',');
            query += ` AND role NOT IN (${placeholders})`;
            params.push(...options.excludeRoles);
        }

        // We use LIKE for the first term as a coarse filter to minimize JS processing
        query += ' AND content LIKE ?';
        params.push(`%${terms[0]}%`);

        const stmt = this.db!.prepare(query);
        const rows = stmt.all(...params) as any[];

        const excludeRoles = new Set(options.excludeRoles ?? []);
        
        return rows
            .map(mapRowToUnit)
            .filter(unit => !options.role || unit.role === options.role)
            .filter(unit => !excludeRoles.has(unit.role))
            .map(unit => ({ unit, score: contentScore(unit, terms) }))
            .filter(result => result.score > 0)
            .sort((a, b) =>
                b.score - a.score ||
                compareUnits(a.unit, b.unit)
            )
            .slice(0, options.limit ?? 20)
            .map(result => toIndex(result.unit));
    }

    async listIndexes(options: SearchOptions = {}): Promise<LogicalUnitIndex[]> {
        this.assertInitialized();
        
        let query = 'SELECT id, type, symbol, filePath, language, startLine, endLine, role, parseStatus FROM logical_units WHERE 1=1';
        const params: any[] = [];

        if (options.role) {
            query += ' AND role = ?';
            params.push(options.role);
        }

        if (options.types && options.types.length > 0) {
            const placeholders = options.types.map(() => '?').join(',');
            query += ` AND type IN (${placeholders})`;
            params.push(...options.types);
        }

        query += ' ORDER BY filePath ASC, startLine ASC';
        
        if (options.limit !== undefined && options.limit !== Number.POSITIVE_INFINITY) {
            query += ' LIMIT ?';
            params.push(options.limit);
        }

        const stmt = this.db!.prepare(query);
        const rows = stmt.all(...params) as any[];
        return rows.map(mapRowToIndex);
    }

    private assertInitialized(): void {
        if (!this.db) {
            throw new Error('LogicalUnitStore is not initialized');
        }
    }
}

function mapRowToUnit(row: any): LogicalUnit {
    return {
        id: row.id,
        uuid: row.uuid ?? undefined,
        type: row.type,
        symbol: row.symbol ?? undefined,
        filePath: row.filePath,
        language: row.language,
        startLine: row.startLine,
        endLine: row.endLine,
        content: row.content,
        parentUnitId: row.parentUnitId ?? undefined,
        parentSymbol: row.parentSymbol ?? undefined,
        role: row.role,
        parseStatus: row.parseStatus,
        extractionMethod: row.extractionMethod,
        metadata: JSON.parse(row.metadata)
    };
}

function mapRowToIndex(row: any): LogicalUnitIndex {
    return {
        id: row.id,
        uuid: row.uuid ?? undefined,
        type: row.type,
        symbol: row.symbol ?? undefined,
        filePath: row.filePath,
        language: row.language,
        startLine: row.startLine,
        endLine: row.endLine,
        role: row.role,
        parseStatus: row.parseStatus
    };
}

function toIndex(unit: LogicalUnit): LogicalUnitIndex {
    return {
        id: unit.id,
        uuid: unit.uuid,
        type: unit.type,
        symbol: unit.symbol,
        filePath: unit.filePath,
        language: unit.language,
        startLine: unit.startLine,
        endLine: unit.endLine,
        role: unit.role,
        parseStatus: unit.parseStatus
    };
}

function contentScore(unit: LogicalUnit, terms: string[]): number {
    const haystack = [
        unit.filePath,
        unit.symbol ?? '',
        unit.type,
        unit.content,
        unit.metadata.readsSymbols?.join(' ') ?? '',
        unit.metadata.writesSymbols?.join(' ') ?? ''
    ].join('\n').toLowerCase();
    return terms.reduce((score, term) => score + occurrences(haystack, term), 0);
}

function occurrences(haystack: string, needle: string): number {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

function tokenize(query: string): string[] {
    return Array.from(new Set(
        query
            .toLowerCase()
            .match(/[a-z0-9_$]+/g) ?? []
    ));
}

function compareUnits(a: LogicalUnit, b: LogicalUnit): number {
    return a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine ||
        a.type.localeCompare(b.type) ||
        (a.symbol ?? a.id).localeCompare(b.symbol ?? b.id) ||
        a.id.localeCompare(b.id);
}
