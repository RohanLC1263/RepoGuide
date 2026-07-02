import * as fs from 'fs/promises';
import * as syncFs from 'fs';
import * as path from 'path';
import { openDatabase, Database, executeTransaction } from '../store/sqliteLoader';
import { EntityRecord, RegistryMetrics } from './types';

export class EntityRegistryStore {
    private db: Database | null = null;
    private dbPath = '';

    private metrics: RegistryMetrics = {
        registryHits: 0,
        registryMisses: 0,
        newUuidCount: 0,
        signatureCollisions: 0,
        aliasResolutions: 0
    };

    constructor(private repoguideDir?: string) {}

    async init(repoRoot: string): Promise<void> {
        const baseDir = this.repoguideDir ?? path.join(repoRoot, '.repoguide');
        this.dbPath = path.join(baseDir, 'entity_registry.db');
        
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        
        this.openAndEnsureSchema();
    }


    private openAndEnsureSchema(): void {
        try {
            this.db = openDatabase(this.dbPath);
            this.ensureSchema();
        } catch (error) {
            if (!isRecoverableSqliteState(error)) {
                throw error;
            }
            this.db?.close();
            this.db = null;
            removeSqliteSidecars(this.dbPath);
            removeRecoverableRegistryDatabase(this.dbPath);
            this.db = openDatabase(this.dbPath);
            this.ensureSchema();
        }
    }

    private ensureSchema(): void {
        this.db!.exec('PRAGMA journal_mode = WAL');
        this.db!.exec('PRAGMA synchronous = NORMAL');
        this.db!.exec(`
            CREATE TABLE IF NOT EXISTS entity_registry (
                uuid TEXT PRIMARY KEY,
                signature TEXT UNIQUE NOT NULL,
                entityType TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                lastSeenAt INTEGER NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_entity_registry_signature ON entity_registry(signature);
        `);

        this.db!.exec(`
            CREATE TABLE IF NOT EXISTS signature_aliases (
                old_signature TEXT PRIMARY KEY,
                new_signature TEXT NOT NULL,
                uuid TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY(uuid) REFERENCES entity_registry(uuid)
            );
            
            CREATE INDEX IF NOT EXISTS idx_signature_aliases_old ON signature_aliases(old_signature);
        `);
    }

    getRecordBySignature(signature: string): EntityRecord | undefined {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT * FROM entity_registry WHERE signature = ?');
        const row = stmt.get(signature) as any;
        if (!row) {
            this.metrics.registryMisses++;
            return undefined;
        }
        this.metrics.registryHits++;
        return {
            uuid: row.uuid,
            signature: row.signature,
            entityType: row.entityType,
            createdAt: row.createdAt,
            lastSeenAt: row.lastSeenAt
        };
    }

    // Resolves alias logic: given a signature, if it's an alias, return the UUID
    getAliasResolution(signature: string): string | undefined {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT uuid FROM signature_aliases WHERE old_signature = ?');
        const row = stmt.get(signature) as any;
        if (row) {
            this.metrics.aliasResolutions++;
            return row.uuid;
        }
        return undefined;
    }

    insertRecord(record: EntityRecord): void {
        this.assertInitialized();
        const stmt = this.db!.prepare(`
            INSERT INTO entity_registry (uuid, signature, entityType, createdAt, lastSeenAt)
            VALUES (@uuid, @signature, @entityType, @createdAt, @lastSeenAt)
        `);
        try {
            stmt.run(record as any);
            this.metrics.newUuidCount++;
        } catch (e: any) {
            if (e.message && e.message.includes('UNIQUE constraint failed')) {
                this.metrics.signatureCollisions++;
                throw new Error('Signature collision detected');
            }
            throw e;
        }
    }

    updateLastSeen(uuid: string, timestamp: number): void {
        this.assertInitialized();
        const stmt = this.db!.prepare('UPDATE entity_registry SET lastSeenAt = ? WHERE uuid = ?');
        stmt.run(timestamp, uuid);
    }

    getMetrics(): RegistryMetrics {
        return { ...this.metrics };
    }

    getAllRecords(): EntityRecord[] {
        this.assertInitialized();
        const stmt = this.db!.prepare('SELECT * FROM entity_registry');
        const rows = stmt.all() as any[];
        return rows.map(r => ({
            uuid: r.uuid,
            signature: r.signature,
            entityType: r.entityType,
            createdAt: r.createdAt,
            lastSeenAt: r.lastSeenAt
        }));
    }

    async clearAll(): Promise<void> {
        this.assertInitialized();
        this.db!.exec('DELETE FROM entity_registry');
        this.db!.exec('DELETE FROM signature_aliases');
        this.resetMetrics();
    }

    resetMetrics(): void {
        this.metrics = {
            registryHits: 0,
            registryMisses: 0,
            newUuidCount: 0,
            signatureCollisions: 0,
            aliasResolutions: 0
        };
    }

    private assertInitialized(): void {
        if (!this.db) {
            throw new Error('EntityRegistryStore is not initialized');
        }
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

function isRecoverableSqliteState(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /disk I\/O error/i.test(message);
}

function removeSqliteSidecars(dbPath: string): void {
    for (const suffix of ['-journal', '-wal', '-shm']) {
        try {
            syncFs.rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
            // Best effort; persistent errors are surfaced by the retry.
        }
    }
}

function removeRecoverableRegistryDatabase(dbPath: string): void {
    try {
        syncFs.rmSync(dbPath, { force: true });
    } catch {
        // The retry will surface persistent filesystem errors.
    }
}
