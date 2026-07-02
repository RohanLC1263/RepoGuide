import test, { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../runtime/runtimeStore';
import { RuntimeHealthBuilder } from '../runtime/runtimeHealthBuilder';
import { RuntimePatternBuilder } from '../runtime/runtimePatternBuilder';

describe('Component 25 Phase C: Health & Patterns', () => {
    let db: DatabaseSync;
    let store: RuntimeStore;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        store = new RuntimeStore(db);
        store.upsertComponent({ component_id: 'auth', description: 'Auth Service' });
    });

    afterEach(() => {
        db.close();
    });

    const setupEvents = (componentId: string, eventType: string, count: number, offsetDays = 0) => {
        store.upsertComponent({ component_id: componentId, description: 'Service' });
        const now = new Date();
        const d = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
        const evs = [];
        for (let i = 0; i < count; i++) {
            evs.push({
                event_id: `e_${Math.random().toString(36).substring(7)}`,
                component_id: componentId,
                event_type: eventType,
                severity: 'HIGH' as any,
                payload: '',
                timestamp: d,
                repository_commit_hash: 'abc'
            });
        }
        store.appendEvents(evs);
    };

    const setupBaseline = (componentId: string, eventType: string, mean: number, variance: number) => {
        db.exec(`
            INSERT INTO runtime_baselines (component_id, event_type, computed_at, mean_frequency, variance)
            VALUES ('${componentId}', '${eventType}', '${new Date().toISOString()}', ${mean}, ${variance})
        `);
    };

    it('Test 1: Healthy component -> HEALTHY', () => {
        setupEvents('auth', 'OOM', 0); // No recent events
        setupBaseline('auth', 'OOM', 1, 0); // Need baseline or component to exist
        store.upsertComponent({ component_id: 'auth', description: 'Service' });
        db.exec(`INSERT INTO runtime_events (event_id, component_id, event_type, severity, timestamp, repository_commit_hash) VALUES ('test', 'auth', 'OK', 'LOW', datetime('now', '-2 days'), 'abc')`);

        new RuntimeHealthBuilder(db).build();

        const health = db.prepare(`SELECT * FROM runtime_health_history WHERE component_id = 'auth' ORDER BY computed_at DESC LIMIT 1`).get() as any;
        assert.equal(health.status, 'HEALTHY');
        assert.equal(health.health_score, 100);
    });

    it('Test 2: Moderately degraded component -> DEGRADED', () => {
        setupBaseline('auth', 'TIMEOUT', 2, 1);
        setupEvents('auth', 'TIMEOUT', 8); 

        new RuntimeHealthBuilder(db).build();

        const health = db.prepare(`SELECT * FROM runtime_health_history WHERE component_id = 'auth' ORDER BY computed_at DESC LIMIT 1`).get() as any;
        assert.equal(health.status, 'DEGRADED');
        assert.ok(health.health_score >= 50 && health.health_score < 90);
    });

    it('Test 3: Severely degraded component -> CRITICAL', () => {
        setupBaseline('auth', 'CRASH', 1, 1);
        setupEvents('auth', 'CRASH', 50); 

        new RuntimeHealthBuilder(db).build();

        const health = db.prepare(`SELECT * FROM runtime_health_history WHERE component_id = 'auth' ORDER BY computed_at DESC LIMIT 1`).get() as any;
        assert.equal(health.status, 'CRITICAL');
        assert.ok(health.health_score < 50);
    });

    it('Test 4: Pattern exceeds baseline + 3σ -> ACTIVE', () => {
        setupBaseline('auth', 'OOM', 1, 1); // 3 sigma is 3. Threshold is max(5, 1+3) = 5.
        setupEvents('auth', 'OOM', 10);

        new RuntimePatternBuilder(db).build();

        const pattern = db.prepare(`SELECT * FROM runtime_patterns WHERE component_id = 'auth' AND status = 'ACTIVE'`).get() as any;
        assert.ok(pattern);
        assert.equal(pattern.status, 'ACTIVE');
    });

    it('Test 5: Pattern returns to baseline -> RESOLVED', () => {
        // First active
        setupBaseline('auth', 'OOM', 1, 1);
        db.exec(`
            INSERT INTO runtime_patterns (pattern_id, component_id, pattern_type, frequency, confidence, discovered_at, status)
            VALUES ('pat1', 'auth', 'OOM', 10, 90, '${new Date().toISOString()}', 'ACTIVE')
        `);

        // Now count is low
        setupEvents('auth', 'OOM', 2); // 2 <= 5
        new RuntimePatternBuilder(db).build();

        const pattern = db.prepare(`SELECT * FROM runtime_patterns WHERE pattern_id = 'pat1'`).get() as any;
        assert.equal(pattern.status, 'RESOLVED');
    });

    it('Test 6: Pattern remains active >30 days -> EXPIRED', () => {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 35);
        db.exec(`
            INSERT INTO runtime_patterns (pattern_id, component_id, pattern_type, frequency, confidence, discovered_at, status)
            VALUES ('pat2', 'auth', 'OOM', 10, 90, '${oldDate.toISOString()}', 'ACTIVE')
        `);

        new RuntimePatternBuilder(db).build();

        const pattern = db.prepare(`SELECT * FROM runtime_patterns WHERE pattern_id = 'pat2'`).get() as any;
        assert.equal(pattern.status, 'EXPIRED');
    });

    it('Test 7: Micro-system noise -> No pattern generated', () => {
        setupBaseline('auth', 'TIMEOUT', 0, 0); // Threshold should hit absolute floor = 5
        setupEvents('auth', 'TIMEOUT', 3); // 3 < 5

        new RuntimePatternBuilder(db).build();

        const count = db.prepare(`SELECT COUNT(*) as c FROM runtime_patterns`).get() as any;
        assert.equal(count.c, 0);
    });
});
