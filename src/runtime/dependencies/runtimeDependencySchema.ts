import { DatabaseSync } from 'node:sqlite';

export function createRuntimeDependencySchema(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_dependency_evidence (
            evidence_id TEXT PRIMARY KEY,
            source_component_id TEXT NOT NULL,
            target_component_id TEXT NOT NULL,
            dependency_type TEXT NOT NULL,
            evidence_source TEXT NOT NULL,
            raw_confidence REAL NOT NULL,
            discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_rde_source ON runtime_dependency_evidence(source_component_id);
        CREATE INDEX IF NOT EXISTS idx_rde_target ON runtime_dependency_evidence(target_component_id);
        CREATE INDEX IF NOT EXISTS idx_rde_time ON runtime_dependency_evidence(discovered_at);

        DROP VIEW IF EXISTS runtime_component_dependencies;
        CREATE VIEW runtime_component_dependencies AS
        WITH decayed_evidence AS (
            SELECT 
                source_component_id,
                target_component_id,
                dependency_type,
                evidence_source,
                CASE 
                    WHEN evidence_source = 'EXPLICIT_CONFIG' THEN raw_confidence
                    WHEN julianday('now') - julianday(discovered_at) <= 7 THEN raw_confidence
                    WHEN julianday('now') - julianday(discovered_at) <= 30 THEN raw_confidence * (1.0 - ((julianday('now') - julianday(discovered_at) - 7) / 23.0) * 0.5)
                    ELSE raw_confidence * 0.5 * MAX(0.0, 1.0 - ((julianday('now') - julianday(discovered_at) - 30) / 60.0))
                END as decayed_confidence
            FROM runtime_dependency_evidence e
            WHERE NOT EXISTS (
                SELECT 1 FROM runtime_dependency_evidence t 
                WHERE t.dependency_type = 'TOMBSTONE' 
                AND t.source_component_id = e.source_component_id
                AND t.target_component_id = e.target_component_id
            )
        )
        SELECT 
            source_component_id,
            target_component_id,
            dependency_type,
            MAX(decayed_confidence) as base_confidence,
            COUNT(DISTINCT evidence_source) as corroboration_count,
            MIN(1.0, MAX(decayed_confidence) + (0.1 * MAX(0, COUNT(DISTINCT evidence_source) - 1))) as final_confidence
        FROM decayed_evidence
        GROUP BY source_component_id, target_component_id, dependency_type
        HAVING final_confidence >= 0.1;
    `);
}
