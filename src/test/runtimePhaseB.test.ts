import test, { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../runtime/runtimeStore';
import { RuntimeBaselineBuilder } from '../runtime/runtimeBaselineBuilder';
import { RuntimeCalibrationBuilder } from '../runtime/runtimeCalibrationBuilder';

describe('Component 25 Phase B: Baseline & Calibration', () => {
    let db: DatabaseSync;
    let store: RuntimeStore;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        store = new RuntimeStore(db);
    });

    afterEach(() => {
        db.close();
    });

    it('Test 1: runtime_events -> runtime_baselines population proof', () => {
        const baselineBuilder = new RuntimeBaselineBuilder(db);

        // Insert some runtime_events
        const now = new Date();
        store.upsertComponent({ component_id: 'auth', description: 'Auth Service' });
        
        for (let i = 0; i < 5; i++) {
            store.appendEvents([{
                event_id: `e${i}`,
                component_id: 'auth',
                event_type: 'TIMEOUT',
                severity: 'HIGH',
                payload: '',
                timestamp: now,
                repository_commit_hash: 'abc'
            }]);
        }

        baselineBuilder.build();

        const baselines = db.prepare(`SELECT * FROM runtime_baselines`).all() as any[];
        assert.equal(baselines.length, 1);
        assert.equal(baselines[0].component_id, 'auth');
        assert.equal(baselines[0].event_type, 'TIMEOUT');
        // mean_frequency = 5 events in 1 day, out of 30 padded days = 5/30
        assert.ok(baselines[0].mean_frequency > 0);
        assert.ok(baselines[0].variance > 0);
    });

    const setupIncidents = (db: DatabaseSync, triggers: string[], type: string = 'HUMAN', payload: string = '{}') => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS incident_events (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                incident_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                trigger_metric TEXT NOT NULL,
                trigger_value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                payload TEXT
            );
        `);
        const stmt = db.prepare(`
            INSERT INTO incident_events (id, entity_type, entity_id, incident_type, severity, trigger_metric, trigger_value, created_at, payload)
            VALUES (?, 'FILE', 'auth.ts', ?, 'CRITICAL', ?, '1', ?, ?)
        `);
        triggers.forEach((t, i) => {
            const rand = Math.random().toString(36).substring(7);
            stmt.run(`inc_${rand}_${i}`, type, t, new Date().toISOString(), payload);
        });
    };

    it('Test 2: 0 incidents -> COLD mode', () => {
        const calibBuilder = new RuntimeCalibrationBuilder(db);
        calibBuilder.build();

        const weights = db.prepare(`SELECT * FROM runtime_calibration_weight_history LIMIT 1`).get() as any;
        assert.equal(weights.mode, 'COLD');
        assert.equal(weights.confidence_score, 0); // 0/30
    });

    it('Test 3: 15 incidents -> WARM mode', () => {
        const calibBuilder = new RuntimeCalibrationBuilder(db);
        setupIncidents(db, Array(15).fill('TIMEOUT').map((t, i) => i % 2 === 0 ? 'TIMEOUT' : 'CRASH'));
        calibBuilder.build();

        const weights = db.prepare(`SELECT * FROM runtime_calibration_weight_history LIMIT 1`).get() as any;
        assert.equal(weights.mode, 'WARM');
        assert.ok(weights.confidence_score > 0);
    });

    it('Test 4: 30+ incidents -> CALIBRATED mode', () => {
        const calibBuilder = new RuntimeCalibrationBuilder(db);
        // Mixed incidents for high diversity
        const triggers = Array(35).fill('OOM').map((_, i) => ['OOM', 'TIMEOUT', 'CRASH', 'DEADLOCK'][i % 4]);
        setupIncidents(db, triggers);
        calibBuilder.build();

        const weights = db.prepare(`SELECT * FROM runtime_calibration_weight_history LIMIT 1`).get() as any;
        assert.equal(weights.mode, 'CALIBRATED');
        assert.equal(weights.confidence_score, 1); // 35/30 = 1, good diversity
    });

    it('Test 5: 30 OOM incidents -> Overfit Risk detected (reduced confidence, non-zero probability floor)', () => {
        const calibBuilder = new RuntimeCalibrationBuilder(db);
        setupIncidents(db, Array(30).fill('OOM'));
        calibBuilder.build();

        const oom = db.prepare(`SELECT * FROM runtime_calibration_weight_history WHERE event_type = 'OOM'`).get() as any;
        const timeout = db.prepare(`SELECT * FROM runtime_calibration_weight_history WHERE event_type = 'TIMEOUT'`).get() as any;

        assert.equal(oom.mode, 'CALIBRATED');
        // Confidence should be heavily penalized (0.6) instead of 1.0 due to 100% OOM (0 entropy)
        assert.equal(oom.confidence_score, 0.6);

        // Due to Laplace smoothing, OOM weight shouldn't be 1.0
        assert.ok(oom.weight < 1.0);
        assert.ok(oom.weight > 0.5); // Still high

        // Unseen TIMEOUT should not be 0.0, but have a floor probability
        assert.ok(timeout.weight > 0.0);
        assert.ok(timeout.weight < 0.2); // Low but non-zero
    });

    it('Test 6: Bot incidents only -> Ignored', () => {
        const calibBuilder = new RuntimeCalibrationBuilder(db);
        
        // Setup 35 bot incidents
        setupIncidents(db, Array(35).fill('REPOGUIDE_AUTOMATION_TRIGGER'));
        setupIncidents(db, Array(10).fill('OOM'), 'BOT', '{"author":"bot"}');
        
        calibBuilder.build();

        const weights = db.prepare(`SELECT * FROM runtime_calibration_weight_history LIMIT 1`).get() as any;
        // Since all were filtered, it behaves like 0 incidents
        assert.equal(weights.mode, 'COLD');
        assert.equal(weights.confidence_score, 0);
    });
});
