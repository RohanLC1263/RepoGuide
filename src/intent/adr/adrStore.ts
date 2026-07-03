import { DatabaseSync } from 'node:sqlite';
import { openDatabase, executeTransaction } from '../../store/sqliteLoader';
import { ADREntity, ADRReference } from './adrTypes';

export class ADRStore {
    private db: DatabaseSync;

    constructor(dbPathOrDb: string | DatabaseSync = ':memory:') {
        if (typeof dbPathOrDb === 'string') {
            this.db = openDatabase(dbPathOrDb);
        } else {
            this.db = dbPathOrDb;
        }
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS adrs (
                id TEXT PRIMARY KEY,
                number TEXT,
                title TEXT,
                status TEXT,
                context TEXT,
                decision TEXT,
                consequences TEXT,
                source_path TEXT,
                source_hash TEXT,
                repository_id TEXT,
                parser_confidence TEXT,
                raw_content TEXT
            );

            CREATE TABLE IF NOT EXISTS adr_references (
                source_adr_id TEXT,
                target_adr_id TEXT,
                relation TEXT,
                FOREIGN KEY(source_adr_id) REFERENCES adrs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    public async save(adr: ADREntity, references: ADRReference[] = []): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            const stmtAdr = this.db.prepare(`
                INSERT INTO adrs (id, number, title, status, context, decision, consequences, source_path, source_hash, repository_id, parser_confidence, raw_content)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    number=excluded.number,
                    title=excluded.title,
                    status=excluded.status,
                    context=excluded.context,
                    decision=excluded.decision,
                    consequences=excluded.consequences,
                    source_path=excluded.source_path,
                    source_hash=excluded.source_hash,
                    repository_id=excluded.repository_id,
                    parser_confidence=excluded.parser_confidence,
                    raw_content=excluded.raw_content
            `);

            stmtAdr.run(
                adr.id,
                adr.number || null,
                adr.title,
                adr.status,
                adr.context,
                adr.decision,
                adr.consequences,
                adr.sourcePath,
                adr.sourceHash,
                adr.repositoryId,
                adr.parserConfidence,
                adr.rawContent
            );

            // Re-insert references
            this.db.prepare(`DELETE FROM adr_references WHERE source_adr_id = ?`).run(adr.id);
            const stmtRef = this.db.prepare(`
                INSERT INTO adr_references (source_adr_id, target_adr_id, relation)
                VALUES (?, ?, ?)
            `);

            for (const ref of references) {
                stmtRef.run(ref.sourceAdrId, ref.targetAdrId, ref.relation);
            }
        });

        tx();
    }

    public async delete(id: string): Promise<void> {
        const tx = executeTransaction(this.db, () => {
            this.db.prepare(`DELETE FROM adrs WHERE id = ?`).run(id);
            this.db.prepare(`DELETE FROM adr_references WHERE source_adr_id = ?`).run(id);
        });
        tx();
    }

    public async getById(id: string): Promise<ADREntity | null> {
        const row = this.db.prepare(`SELECT * FROM adrs WHERE id = ?`).get(id) as any;
        if (!row) return null;
        return this.mapRowToEntity(row);
    }

    public async list(): Promise<ADREntity[]> {
        const rows = this.db.prepare(`SELECT * FROM adrs`).all() as any[];
        return rows.map(r => this.mapRowToEntity(r));
    }

    public async getReferences(id: string): Promise<ADRReference[]> {
        const rows = this.db.prepare(`SELECT * FROM adr_references WHERE source_adr_id = ?`).all(id) as any[];
        return rows.map(r => ({
            sourceAdrId: r.source_adr_id,
            targetAdrId: r.target_adr_id,
            relation: r.relation
        }));
    }

    public getHashForPath(path: string): string | null {
        const row = this.db.prepare(`SELECT source_hash FROM adrs WHERE source_path = ?`).get(path) as any;
        return row ? row.source_hash : null;
    }

    private mapRowToEntity(row: any): ADREntity {
        return {
            id: row.id,
            number: row.number,
            title: row.title,
            status: row.status as any,
            context: row.context,
            decision: row.decision,
            consequences: row.consequences,
            sourcePath: row.source_path,
            sourceHash: row.source_hash,
            repositoryId: row.repository_id,
            parserConfidence: row.parser_confidence as any,
            rawContent: row.raw_content
        };
    }

    public close() {
        this.db.close();
    }
}
