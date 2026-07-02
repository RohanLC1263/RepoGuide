import { DatabaseSync } from 'node:sqlite';

export class DriftRuleEngine {
    constructor(private db: DatabaseSync) {}

    public executeRules() {
        // Prepare temporary table for current findings
        this.db.exec(`
            DROP TABLE IF EXISTS temp_current_findings;
            CREATE TEMP TABLE temp_current_findings (
                id TEXT PRIMARY KEY,
                entity_id TEXT,
                drift_type TEXT,
                severity TEXT,
                adr_id TEXT,
                intent_id TEXT,
                node_id TEXT,
                confidence REAL,
                evidence_count INTEGER
            );

            DROP TABLE IF EXISTS temp_current_evidence;
            CREATE TEMP TABLE temp_current_evidence (
                finding_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT
            );
        `);

        this.executeMissingImplementation();
        this.executeOrphanedImplementation();
        this.executeIntentMismatch();
        this.executeGovernanceViolation();
        this.executeExcessiveCoupling();
        this.executeStaleDecision();
    }

    private executeMissingImplementation() {
        // ADRs with no links
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, adr_id, confidence, evidence_count)
            SELECT 
                'MISSING_IMPLEMENTATION|' || a.id || '||',
                a.id as entity_id,
                'MISSING_IMPLEMENTATION',
                'LOW',
                a.id,
                1.0,
                1
            FROM adrs a
            LEFT JOIN adr_code_links l ON a.id = l.adr_id
            WHERE l.id IS NULL;
            
            INSERT INTO temp_current_evidence (finding_id, evidence_type, evidence_id, evidence_text)
            SELECT 
                'MISSING_IMPLEMENTATION|' || a.id || '||',
                'ADR',
                a.id,
                'ADR has no associated code implementations'
            FROM adrs a
            LEFT JOIN adr_code_links l ON a.id = l.adr_id
            WHERE l.id IS NULL;
        `);
    }

    private executeOrphanedImplementation() {
        // High change count files with no ADRs
        // Assuming file_change_stats exists. If not, we fall back gracefully or assume we joined it.
        // Wait, file_change_stats is built in component 12.
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, node_id, confidence, evidence_count)
            SELECT 
                'ORPHANED_IMPLEMENTATION|||' || f.path,
                'UNGOVERNED_CLUSTER' as entity_id,
                'ORPHANED_IMPLEMENTATION',
                CASE WHEN f.change_count > 100 THEN 'CRITICAL' ELSE 'MEDIUM' END,
                f.path,
                1.0,
                1
            FROM file_change_stats f
            LEFT JOIN adr_code_links l ON f.path = l.node_id
            WHERE l.id IS NULL AND f.change_count > 50;

            INSERT INTO temp_current_evidence (finding_id, evidence_type, evidence_id, evidence_text)
            SELECT 
                'ORPHANED_IMPLEMENTATION|||' || f.path,
                'NODE',
                f.path,
                'Architecturally significant file (changes: ' || f.change_count || ') has no governing ADR'
            FROM file_change_stats f
            LEFT JOIN adr_code_links l ON f.path = l.node_id
            WHERE l.id IS NULL AND f.change_count > 50;
        `);
    }

    private executeIntentMismatch() {
        // File governed by ADR but expected intent not present.
        // Actually, for V1, we'll flag any file that has an ADR link but ZERO intent evidence.
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, adr_id, node_id, confidence, evidence_count)
            SELECT 
                'INTENT_MISMATCH|' || l.adr_id || '||' || l.node_id,
                l.adr_id as entity_id,
                'INTENT_MISMATCH',
                'HIGH',
                l.adr_id,
                l.node_id,
                0.8,
                2
            FROM adr_code_links l
            LEFT JOIN intent_evidence e ON l.node_id = e.source_id AND e.source_type = 'FILE'
            WHERE e.intent_id IS NULL;

            INSERT INTO temp_current_evidence (finding_id, evidence_type, evidence_id, evidence_text)
            SELECT 'INTENT_MISMATCH|' || l.adr_id || '||' || l.node_id, 'ADR', l.adr_id, 'Governing ADR'
            FROM adr_code_links l LEFT JOIN intent_evidence e ON l.node_id = e.source_id AND e.source_type = 'FILE' WHERE e.intent_id IS NULL;

            INSERT INTO temp_current_evidence (finding_id, evidence_type, evidence_id, evidence_text)
            SELECT 'INTENT_MISMATCH|' || l.adr_id || '||' || l.node_id, 'NODE', l.node_id, 'Node has no extracted intent evidence'
            FROM adr_code_links l LEFT JOIN intent_evidence e ON l.node_id = e.source_id AND e.source_type = 'FILE' WHERE e.intent_id IS NULL;
        `);
    }

    private executeGovernanceViolation() {
        // Rule 4: GOVERNANCE_VIOLATION via Logical Coupling
        // Two files are highly logically coupled but belong to different ADRs
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, adr_id, node_id, confidence, evidence_count)
            SELECT 
                'GOVERNANCE_VIOLATION|' || l1.adr_id || '||' || c.source_path || '|' || c.target_path,
                l1.adr_id as entity_id,
                'GOVERNANCE_VIOLATION',
                'CRITICAL',
                l1.adr_id,
                c.source_path,
                1.0,
                1
            FROM adr_code_links l1
            JOIN logical_coupling_edges c ON l1.node_id = c.source_path
            JOIN adr_code_links l2 ON c.target_path = l2.node_id
            WHERE l1.adr_id != l2.adr_id
            -- Ensure high confidence coupling
            AND c.confidence > 0.5
            AND c.co_change_count > 5;

            INSERT INTO temp_current_evidence (finding_id, evidence_type, evidence_id, evidence_text)
            SELECT DISTINCT 'GOVERNANCE_VIOLATION|' || l1.adr_id || '||' || c.source_path || '|' || c.target_path, 'COUPLING', c.source_path || '<->' || c.target_path, 'Strongly coupled to distinct governance boundary ' || l2.adr_id
            FROM adr_code_links l1
            JOIN logical_coupling_edges c ON l1.node_id = c.source_path
            JOIN adr_code_links l2 ON c.target_path = l2.node_id
            WHERE l1.adr_id != l2.adr_id AND c.confidence > 0.5 AND c.co_change_count > 5;
        `);
    }

    private executeExcessiveCoupling() {
        // High coupling across multiple adrs.
        // Simplification: Node coupled to > 3 different ADRs
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, adr_id, node_id, confidence, evidence_count)
            SELECT 
                'EXCESSIVE_COUPLING|' || l1.adr_id || '||' || c.source_path,
                l1.adr_id as entity_id,
                'EXCESSIVE_COUPLING',
                'HIGH',
                l1.adr_id,
                c.source_path,
                1.0,
                1
            FROM adr_code_links l1
            JOIN logical_coupling_edges c ON l1.node_id = c.source_path
            JOIN adr_code_links l2 ON c.target_path = l2.node_id
            WHERE l1.adr_id != l2.adr_id
            GROUP BY l1.adr_id, c.source_path
            HAVING COUNT(DISTINCT l2.adr_id) >= 3;
        `);
    }

    private executeStaleDecision() {
        // ADR older than 1 year, but files heavily active.
        // Assuming adrs table has created_at
        this.db.exec(`
            INSERT OR REPLACE INTO temp_current_findings (id, entity_id, drift_type, severity, adr_id, confidence, evidence_count)
            SELECT 
                'STALE_DECISION|' || a.id || '||',
                a.id as entity_id,
                'STALE_DECISION',
                'MEDIUM',
                a.id,
                1.0,
                1
            FROM adrs a
            JOIN adr_code_links l ON a.id = l.adr_id
            JOIN file_change_stats f ON l.node_id = f.path
            WHERE julianday('now') - julianday(a.created_at) > 365
            GROUP BY a.id
            HAVING SUM(f.change_count) > 100;
        `);
    }
}
