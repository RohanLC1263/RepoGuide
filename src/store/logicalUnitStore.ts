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

    /**
     * Finds class/interface CONTAINER units whose symbol *contains* the given fragment
     * (case-insensitive substring), largest span first. Unlike searchBySymbol (exact match),
     * this maps a feature word from a broad question -- e.g. "interview" -- to its
     * implementing container -- e.g. "CustomizationInterviewAgent" -- so a broad "explain this
     * feature" question can pull the class-level unit (whose head carries the class docstring,
     * config, and thresholds) instead of only whatever narrow method chunk the semantic search
     * surfaced. Ordered by span DESC so the real container ranks above small helpers that
     * merely share the substring. Container-only (class/interface) to keep this precise.
     */
    async searchContainerUnitsByFragment(fragment: string, options: { limit?: number; excludeRoles?: string[] } = {}): Promise<LogicalUnitIndex[]> {
        this.assertInitialized();
        const frag = fragment.toLowerCase().trim();
        if (frag.length < 4) {
            return [];
        }
        const params: any[] = [`%${frag}%`];
        let query = "SELECT id, type, symbol, filePath, language, startLine, endLine, role, parseStatus FROM logical_units WHERE type IN ('class','interface') AND symbol IS NOT NULL AND lower(symbol) LIKE ?";
        if (options.excludeRoles && options.excludeRoles.length > 0) {
            query += ` AND role NOT IN (${options.excludeRoles.map(() => '?').join(',')})`;
            params.push(...options.excludeRoles);
        }
        query += ' ORDER BY (endLine - startLine) DESC LIMIT ?';
        params.push(options.limit ?? 5);
        const rows = this.db!.prepare(query).all(...params) as any[];
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

        // Coarse filter: any significant term may appear in `content`. Narrowing to
        // only the first term (previously) meant the filter's usefulness depended
        // entirely on which word happened to occur first in the query's sentence
        // order, even when that word was one of the least code-relevant ones (e.g.
        // "happens" from "what happens when..."), silently excluding units that
        // matched every OTHER term. contentScore() below still ranks by how many
        // terms actually match, so widening the candidate pool changes recall, not
        // ranking quality.
        query += ` AND (${terms.map(() => 'content LIKE ?').join(' OR ')})`;
        params.push(...terms.map(term => `%${term}%`));

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
