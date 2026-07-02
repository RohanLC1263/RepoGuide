import { DatabaseSync } from 'node:sqlite';

export function createRuntimeBlastRadiusSchema(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_blast_radius (
            orchestrator_cycle_id TEXT NOT NULL,
            target_component_id TEXT NOT NULL,
            blast_radius_score REAL NOT NULL,
            explanation_json TEXT NOT NULL,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (orchestrator_cycle_id, target_component_id)
        );

        CREATE INDEX IF NOT EXISTS idx_rbr_cycle ON runtime_blast_radius(orchestrator_cycle_id);
        CREATE INDEX IF NOT EXISTS idx_rbr_target ON runtime_blast_radius(target_component_id);
    `);
}
