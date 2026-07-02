import { DatabaseSync } from 'node:sqlite';

export interface BlastRadiusRecord {
    orchestrator_cycle_id: string;
    target_component_id: string;
    blast_radius_score: number;
    explanation_json: string;
}

export class RuntimeBlastRadiusStore {
    constructor(private db: DatabaseSync) {}

    public saveBatch(records: BlastRadiusRecord[]): void {
        const insertStmt = this.db.prepare(`
            INSERT INTO runtime_blast_radius (
                orchestrator_cycle_id, target_component_id, blast_radius_score, explanation_json
            ) VALUES (?, ?, ?, ?)
        `);

        this.db.exec('BEGIN TRANSACTION;');
        try {
            for (const record of records) {
                insertStmt.run(
                    record.orchestrator_cycle_id,
                    record.target_component_id,
                    record.blast_radius_score,
                    record.explanation_json
                );
            }
            this.db.exec('COMMIT;');
        } catch (error) {
            this.db.exec('ROLLBACK;');
            throw error;
        }
    }

    public getByCycleId(cycleId: string): BlastRadiusRecord[] {
        const stmt = this.db.prepare(`
            SELECT orchestrator_cycle_id, target_component_id, blast_radius_score, explanation_json
            FROM runtime_blast_radius
            WHERE orchestrator_cycle_id = ?
        `);
        return stmt.all(cycleId) as any as BlastRadiusRecord[];
    }

    public clearCycle(cycleId: string): void {
        const stmt = this.db.prepare(`
            DELETE FROM runtime_blast_radius
            WHERE orchestrator_cycle_id = ?
        `);
        stmt.run(cycleId);
    }
}
