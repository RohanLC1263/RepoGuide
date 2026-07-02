import { DatabaseSync } from 'node:sqlite';

export class ChangeImpactStore {
    constructor(private db: DatabaseSync) {
        this.initializeSchema();
    }

    private initializeSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS change_risk_frequencies (
                feature_name TEXT NOT NULL PRIMARY KEY,
                total_occurrences INTEGER NOT NULL,
                incident_occurrences INTEGER NOT NULL,
                probability REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS change_risk_predictions (
                entity_id TEXT PRIMARY KEY,
                base_failure_probability REAL NOT NULL,
                primary_risk_driver TEXT NOT NULL,
                sample_size INTEGER NOT NULL
            );
        `);
    }

    public truncateFrequencies() {
        this.db.exec('DELETE FROM change_risk_frequencies;');
    }

    public truncatePredictions() {
        this.db.exec('DELETE FROM change_risk_predictions;');
    }
}
