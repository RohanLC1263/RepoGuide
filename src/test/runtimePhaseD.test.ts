import test, { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IncidentIntelligenceBuilder } from '../runtime/../incidents/incidentIntelligenceBuilder';
import { IncidentIntelligenceStore } from '../runtime/../incidents/incidentIntelligenceStore';

describe('Component 25 Phase D: Orchestration & Incident Intelligence', () => {
    let db: DatabaseSync;
    let store: IncidentIntelligenceStore;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Setup initial schema for Incident Intelligence
        db.exec(`
            CREATE TABLE incident_events (
                id TEXT PRIMARY KEY,
                entity_id TEXT,
                incident_type TEXT,
                severity TEXT,
                created_at TEXT
            );
            CREATE TABLE incident_factors (
                factor_id TEXT PRIMARY KEY,
                incident_id TEXT,
                factor_type TEXT,
                contribution_score INTEGER
            );
            CREATE TABLE incident_patterns (
                pattern_id TEXT PRIMARY KEY,
                incident_type TEXT,
                factor_pattern TEXT,
                frequency INTEGER,
                confidence INTEGER
            );
            CREATE TABLE incident_predictions (
                prediction_id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id TEXT,
                entity_type TEXT,
                risk_score REAL,
                severity TEXT,
                confidence INTEGER,
                primary_risk_driver TEXT
            );
            CREATE TABLE coverage_history (
                entity_id TEXT,
                coverage_percent INTEGER,
                snapshot_date TEXT
            );
            -- Mirrors knowledgeHotspotStore.ts exactly. The fixture previously gave
            -- hotspot_history an entity_id column, which production does NOT have: the
            -- real table keys on hotspot_id and reaches entity_id by joining
            -- knowledge_hotspots. Without that table every test here failed with
            -- "no such table: knowledge_hotspots" before reaching an assertion.
            CREATE TABLE knowledge_hotspots (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                hotspot_score REAL,
                severity TEXT,
                bus_factor INTEGER,
                expert_count INTEGER,
                knowledge_concentration_score REAL,
                health_score REAL,
                blast_radius_score REAL,
                coupling_score REAL
            );
            CREATE TABLE hotspot_history (
                hotspot_id TEXT,
                snapshot_date TEXT,
                severity TEXT,
                hotspot_score REAL,
                bus_factor INTEGER,
                expert_count INTEGER,
                health_score REAL,
                blast_radius_score REAL,
                coupling_score REAL
            );
            CREATE TABLE architectural_health_history (
                entity_id TEXT,
                health_score INTEGER,
                snapshot_date TEXT
            );
            -- Mirrors decisionOutcomeStore.ts. The fixture had a single adr_id column;
            -- production keys on (entity_type, entity_id) and the builder filters
            -- entity_type = 'ADR'.
            CREATE TABLE decision_outcomes (
                entity_type TEXT,
                entity_id TEXT,
                outcome_type TEXT,
                outcome_score REAL,
                calculated_at TEXT
            );
            -- Mirrors knowledgeValidityStore.ts. validity_history keys on validity_id and
            -- reaches an entity only through knowledge_validity, which the fixture omitted
            -- entirely -- so the prediction query could not resolve entity_id at all.
            CREATE TABLE knowledge_validity (
                id TEXT PRIMARY KEY,
                entity_type TEXT,
                entity_id TEXT,
                validity_score REAL,
                validity_tier TEXT,
                confidence_score REAL,
                trend TEXT,
                last_validated_at TEXT,
                evidence_count INTEGER
            );
            CREATE TABLE validity_history (
                validity_id TEXT,
                snapshot_date TEXT,
                validity_score REAL,
                confidence_score REAL
            );
        `);

        store = new IncidentIntelligenceStore(db);
    });

    afterEach(() => {
        db.close();
    });

    const setupRuntimeTables = () => {
        db.exec(`
            CREATE TABLE runtime_components (
                component_id TEXT PRIMARY KEY,
                description TEXT
            );
            CREATE TABLE runtime_repository_mappings (
                mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
                component_id TEXT,
                entity_id TEXT,
                entity_type TEXT
            );
            CREATE TABLE runtime_health_history (
                component_id TEXT,
                computed_at TEXT,
                health_score INTEGER,
                status TEXT,
                primary_driver TEXT,
                repository_commit_hash TEXT
            );
            CREATE TABLE runtime_patterns (
                pattern_id TEXT PRIMARY KEY,
                component_id TEXT,
                pattern_type TEXT,
                frequency INTEGER,
                confidence INTEGER,
                discovered_at TEXT,
                status TEXT
            );

            INSERT INTO runtime_components (component_id, description) VALUES ('auth_comp', 'Auth Component');
            INSERT INTO runtime_repository_mappings (component_id, entity_id, entity_type) VALUES ('auth_comp', 'file_1', 'FILE');
        `);
    };

    it('Test 1: No runtime data present -> Old behavior', async () => {
        setupRuntimeTables(); // tables exist but no data
        db.exec(`
            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now'))
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factors = db.prepare(`SELECT * FROM incident_factors`).all();
        assert.equal(factors.length, 0); // No factors
    });

    it('Test 2: Component status = DEGRADED -> RUNTIME_DEGRADATION factor', async () => {
        setupRuntimeTables();
        db.exec(`
            INSERT INTO runtime_health_history (component_id, computed_at, health_score, status)
            VALUES ('auth_comp', datetime('now'), 75, 'DEGRADED');

            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now', '+1 hour'));
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factor = db.prepare(`SELECT factor_type FROM incident_factors WHERE incident_id = 'inc1'`).get() as any;
        assert.ok(factor);
        assert.equal(factor.factor_type, 'RUNTIME_DEGRADATION');
    });

    it('Test 3: Component status = CRITICAL -> RUNTIME_CRITICAL factor', async () => {
        setupRuntimeTables();
        db.exec(`
            INSERT INTO runtime_health_history (component_id, computed_at, health_score, status)
            VALUES ('auth_comp', datetime('now'), 25, 'CRITICAL');

            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now', '+1 hour'));
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factor = db.prepare(`SELECT factor_type FROM incident_factors WHERE incident_id = 'inc1'`).get() as any;
        assert.ok(factor);
        assert.equal(factor.factor_type, 'RUNTIME_CRITICAL');
    });

    it('Test 4: ACTIVE pattern exists -> RECURRING_RUNTIME_PATTERN factor', async () => {
        setupRuntimeTables();
        db.exec(`
            INSERT INTO runtime_patterns (pattern_id, component_id, status, discovered_at)
            VALUES ('pat1', 'auth_comp', 'ACTIVE', datetime('now'));

            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now', '+1 hour'));
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factor = db.prepare(`SELECT factor_type FROM incident_factors WHERE incident_id = 'inc1'`).get() as any;
        assert.ok(factor);
        assert.equal(factor.factor_type, 'RECURRING_RUNTIME_PATTERN');
    });

    it('Test 5: Risk normalization -> Ri = (100 - HealthScore) / 100', async () => {
        setupRuntimeTables();
        db.exec(`
            INSERT INTO runtime_health_history (component_id, computed_at, health_score, status)
            VALUES ('auth_comp', datetime('now'), 0, 'CRITICAL');
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const prediction = db.prepare(`SELECT * FROM incident_predictions WHERE entity_id = 'file_1'`).get() as any;
        assert.ok(prediction);
        assert.equal(prediction.risk_score, 100);
        assert.equal(prediction.primary_risk_driver, 'RUNTIME');
    });

    it('Test 6: Existing factors preserved -> Coverage, Hotspots, Bus Factor coexist', async () => {
        setupRuntimeTables();
        db.exec(`
            INSERT INTO knowledge_hotspots (id, entity_type, entity_id, bus_factor) VALUES ('hs_1', 'FILE', 'file_1', 1);
            INSERT INTO hotspot_history (hotspot_id, bus_factor, snapshot_date) VALUES ('hs_1', 1, datetime('now'));
            INSERT INTO runtime_health_history (component_id, computed_at, health_score, status)
            VALUES ('auth_comp', datetime('now'), 75, 'DEGRADED');

            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now', '+1 hour'));
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factors = db.prepare(`SELECT factor_type FROM incident_factors WHERE incident_id = 'inc1'`).all() as any[];
        const factorTypes = factors.map(f => f.factor_type);
        
        assert.ok(factorTypes.includes('BUS_FACTOR_RISK'));
        assert.ok(factorTypes.includes('RUNTIME_DEGRADATION'));
    });

    it('Test 7: Rollback validation -> Disable Runtime Intelligence returns old behavior', async () => {
        // DO NOT setupRuntimeTables() here.
        // This simulates Runtime Intelligence being completely disabled or removed.
        
        db.exec(`
            INSERT INTO knowledge_hotspots (id, entity_type, entity_id, bus_factor, blast_radius_score) VALUES ('hs_1', 'FILE', 'file_1', 1, 100);
            INSERT INTO hotspot_history (hotspot_id, bus_factor, blast_radius_score, snapshot_date) VALUES ('hs_1', 1, 100, datetime('now'));
            INSERT INTO incident_events (id, entity_id, incident_type, severity, created_at)
            VALUES ('inc1', 'file_1', 'CRASH', 'HIGH', datetime('now', '+1 hour'));
        `);

        await new IncidentIntelligenceBuilder(db, store).build();

        const factors = db.prepare(`SELECT factor_type FROM incident_factors WHERE incident_id = 'inc1'`).all() as any[];
        assert.equal(factors.length, 1);
        assert.equal(factors[0].factor_type, 'BUS_FACTOR_RISK');

        const predictions = db.prepare(`SELECT * FROM incident_predictions WHERE entity_id = 'file_1'`).all() as any[];
        assert.equal(predictions.length, 1); // Only file_1 was in active_entities because of hotspot
    });
});
