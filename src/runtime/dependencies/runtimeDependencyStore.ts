import { DatabaseSync } from 'node:sqlite';

export interface DependencyEvidence {
    evidence_id: string;
    source_component_id: string;
    target_component_id: string;
    dependency_type: string;
    evidence_source: string;
    raw_confidence: number;
    discovered_at?: string;
}

export class RuntimeDependencyStore {
    constructor(private db: DatabaseSync) {}

    public appendEvidence(evidence: DependencyEvidence): void {
        const stmt = this.db.prepare(`
            INSERT INTO runtime_dependency_evidence 
            (evidence_id, source_component_id, target_component_id, dependency_type, evidence_source, raw_confidence, discovered_at)
            VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
        `);
        stmt.run(
            evidence.evidence_id,
            evidence.source_component_id,
            evidence.target_component_id,
            evidence.dependency_type,
            evidence.evidence_source,
            evidence.raw_confidence,
            evidence.discovered_at || null
        );
    }

    public pruneGhostNodes(): void {
        this.db.exec(`
            DELETE FROM runtime_dependency_evidence 
            WHERE discovered_at < datetime('now', '-90 days') 
            AND evidence_source != 'EXPLICIT_CONFIG'
        `);
    }

    public getAllEvidence(): any[] {
        return this.db.prepare(`SELECT * FROM runtime_dependency_evidence`).all() as any[];
    }

    public getActiveGraph(): any[] {
        return this.db.prepare(`SELECT * FROM runtime_component_dependencies`).all() as any[];
    }
}
