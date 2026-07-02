import { DatabaseSync } from 'node:sqlite';

export interface ChangeSetPrediction {
    failure_probability: number;
    severity: string;
    confidence: number;
    expected_incident_types: string[];
    risk_drivers: string[];
}

export interface PredictionSnapshot {
    prediction_hash: string;
    commit_hash: string;
    prediction_engine_version: string;
    captured_from_event: string;
    timestamp: number;
    author: string;
    failure_probability: number;
    severity: string;
    confidence: number;
    expected_incident_types: string;
    risk_drivers: string;
}

export class PredictionAccountabilityStore {
    constructor(private db: DatabaseSync) {
        this.initializeSchema();
    }

    private initializeSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prediction_snapshots (
                prediction_hash TEXT PRIMARY KEY,
                commit_hash TEXT NOT NULL,
                prediction_engine_version TEXT NOT NULL,
                captured_from_event TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                author TEXT NOT NULL,
                failure_probability REAL NOT NULL,
                severity TEXT NOT NULL,
                confidence REAL NOT NULL,
                expected_incident_types TEXT,
                risk_drivers TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_snapshot_time ON prediction_snapshots(timestamp);
            CREATE INDEX IF NOT EXISTS idx_snapshot_commit ON prediction_snapshots(commit_hash);

            CREATE TABLE IF NOT EXISTS prediction_outcomes (
                prediction_hash TEXT PRIMARY KEY,
                outcome_timestamp INTEGER NOT NULL,
                incident_occurred INTEGER NOT NULL,
                incident_type_match TEXT,
                resolution_state TEXT NOT NULL,
                FOREIGN KEY(prediction_hash) REFERENCES prediction_snapshots(prediction_hash) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_outcome_state ON prediction_outcomes(resolution_state);

            CREATE TABLE IF NOT EXISTS prediction_metrics (
                metric_name TEXT NOT NULL,
                engine_version TEXT NOT NULL,
                window_days INTEGER NOT NULL,
                metric_value REAL NOT NULL,
                computed_at INTEGER NOT NULL,
                PRIMARY KEY (metric_name, engine_version, window_days, computed_at)
            );
        `);
    }

    public saveSnapshot(
        predictionHash: string,
        commitHash: string,
        engineVersion: string,
        capturedFromEvent: string,
        author: string,
        prediction: ChangeSetPrediction
    ) {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO prediction_snapshots (
                prediction_hash, commit_hash, prediction_engine_version,
                captured_from_event, timestamp, author, failure_probability,
                severity, confidence, expected_incident_types, risk_drivers
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            predictionHash,
            commitHash,
            engineVersion,
            capturedFromEvent,
            Date.now(),
            author,
            prediction.failure_probability,
            prediction.severity,
            prediction.confidence,
            JSON.stringify(prediction.expected_incident_types),
            JSON.stringify(prediction.risk_drivers)
        );
    }

    public getDatabase(): DatabaseSync {
        return this.db;
    }
}
