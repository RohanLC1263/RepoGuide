import { DatabaseSync } from 'node:sqlite';
import { DecisionOutcome, OutcomeEvidence, DecisionOutcomeSnapshot } from './decisionOutcomeTypes';

export class DecisionOutcomeStore {
    constructor(private db: DatabaseSync) {
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS decision_outcomes (
                entity_type TEXT,
                entity_id TEXT,
                outcome_type TEXT,
                outcome_score REAL,
                confidence_score REAL,
                evidence_count INTEGER,
                incident_count INTEGER,
                review_failure_count INTEGER,
                health_trend TEXT,
                validity_trend TEXT,
                calculated_at TEXT,
                PRIMARY KEY (entity_type, entity_id)
            );

            CREATE TABLE IF NOT EXISTS outcome_evidence (
                entity_type TEXT,
                entity_id TEXT,
                evidence_type TEXT,
                evidence_id TEXT,
                evidence_text TEXT
            );

            CREATE TABLE IF NOT EXISTS outcome_history (
                entity_type TEXT,
                entity_id TEXT,
                snapshot_date TEXT,
                outcome_type TEXT,
                outcome_score REAL,
                confidence_score REAL,
                evidence_count INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_outcomes_score ON decision_outcomes(outcome_score DESC);
            CREATE INDEX IF NOT EXISTS idx_outcomes_type ON decision_outcomes(outcome_type);
            CREATE INDEX IF NOT EXISTS idx_outcome_evidence_entity ON outcome_evidence(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_outcome_history_entity ON outcome_history(entity_type, entity_id);
        `);
    }

    public clearAll() {
        this.db.exec(`
            DELETE FROM decision_outcomes;
            DELETE FROM outcome_evidence;
        `);
    }
}
