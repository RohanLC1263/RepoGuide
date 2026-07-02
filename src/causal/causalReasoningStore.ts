import { DatabaseSync } from 'node:sqlite';
import { CausalExplanation, CausalFactor, CausalChain, CausalEvidence } from './causalReasoningTypes';

export class CausalReasoningStore {
    private db: DatabaseSync;

    constructor(db: DatabaseSync) {
        this.db = db;
        this.init();
    }

    private init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS causal_explanations (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                outcome_id TEXT,
                explanation_type TEXT,
                confidence_score REAL,
                generated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS causal_factors (
                explanation_id TEXT,
                factor_type TEXT,
                factor_id TEXT,
                contribution_score REAL,
                description TEXT
            );

            CREATE TABLE IF NOT EXISTS causal_chains (
                explanation_id TEXT,
                sequence_order INTEGER,
                source_event_id TEXT,
                target_event_id TEXT,
                relationship TEXT
            );

            CREATE TABLE IF NOT EXISTS causal_evidence (
                explanation_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_causal_exp_entity ON causal_explanations(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_causal_exp_outcome ON causal_explanations(outcome_id);
            CREATE INDEX IF NOT EXISTS idx_causal_factors_exp ON causal_factors(explanation_id);
            CREATE INDEX IF NOT EXISTS idx_causal_chains_exp ON causal_chains(explanation_id);
            CREATE INDEX IF NOT EXISTS idx_causal_evidence_exp ON causal_evidence(explanation_id);
        `);
    }

    public getDatabase(): DatabaseSync {
        return this.db;
    }

    public clearAll() {
        this.db.exec(`
            DELETE FROM causal_evidence;
            DELETE FROM causal_chains;
            DELETE FROM causal_factors;
            DELETE FROM causal_explanations;
        `);
    }
}
