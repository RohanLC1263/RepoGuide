import { describe, it, expect, beforeEach } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../runtime/runtimeStore';
import { RuntimeIntelligenceBuilder } from '../runtime/runtimeIntelligenceBuilder';
import { IncidentIntelligenceStore } from '../incidents/incidentIntelligenceStore';
import { IncidentIntelligenceBuilder } from '../incidents/incidentIntelligenceBuilder';
import { QueryIntentRouter } from '../query/queryIntentRouter';
import { buildEvidencePlan } from '../query/evidencePlanner';
import { RepositoryBrainEvidenceStore } from '../query/repositoryBrainEvidenceStore';
import { RuntimeIntelligenceQueryEngine } from '../runtime/runtimeIntelligenceQueryEngine';

describe('Component 25 Phase E: MCP & Query Integration', () => {
    let db: DatabaseSync;
    let rtStore: RuntimeStore;
    let incStore: IncidentIntelligenceStore;
    let rtBuilder: RuntimeIntelligenceBuilder;
    let incBuilder: IncidentIntelligenceBuilder;
    let intentRouter: QueryIntentRouter;
    let evidenceStore: RepositoryBrainEvidenceStore;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        // Setup base tables
        db.exec(`
            CREATE TABLE incident_events (
                id TEXT PRIMARY KEY,
                entity_id TEXT,
                incident_type TEXT,
                severity TEXT,
                trigger_metric TEXT,
                payload TEXT,
                created_at TEXT
            );
            CREATE TABLE coverage_history (
                entity_id TEXT,
                coverage_percent INTEGER,
                snapshot_date TEXT
            );
            CREATE TABLE hotspot_history (
                entity_id TEXT,
                bus_factor INTEGER,
                hotspot_score REAL,
                blast_radius_score REAL,
                coupling_score REAL,
                snapshot_date TEXT
            );
            CREATE TABLE architectural_health_history (
                entity_id TEXT,
                health_score INTEGER,
                snapshot_date TEXT
            );
            CREATE TABLE decision_outcomes (
                adr_id TEXT,
                outcome_type TEXT
            );
            CREATE TABLE validity_history (
                entity_id TEXT,
                validity_score INTEGER,
                snapshot_date TEXT
            );
        `);

        rtStore = new RuntimeStore(db);
        incStore = new IncidentIntelligenceStore(db);


        // Setup Runtime Intelligence
        const now = new Date();
        rtStore.upsertComponent({ component_id: 'auth', description: 'Auth Service' });
        db.exec(`
            INSERT INTO runtime_repository_mappings (mapping_id, component_id, entity_id, entity_type, snapshot_date) 
            VALUES ('map_1', 'auth', 'src/auth/auth.ts', 'FILE', '${now.toISOString()}');
        `);

        // Force 'auth' into a DEGRADED/ACTIVE PATTERN state by faking baseline and weight
        db.exec(`
            INSERT INTO runtime_baselines (component_id, event_type, computed_at, mean_frequency, variance)
            VALUES ('auth', 'TIMEOUT', '2020-01-01T00:00:00.000Z', 1.0, 1.0)
        `);
        db.exec(`
            INSERT INTO runtime_calibration_weight_history (event_type, computed_at, weight, confidence_score, mode)
            VALUES ('TIMEOUT', '2020-01-01T00:00:00.000Z', 0.8, 1.0, 'CALIBRATED')
        `);

        const evs = [];
        for (let i = 0; i < 20; i++) {
            evs.push({
                event_id: `e_${i}`,
                component_id: 'auth',
                event_type: 'TIMEOUT',
                severity: 'HIGH' as any,
                payload: '',
                timestamp: now,
                repository_commit_hash: 'abc'
            });
        }
        rtStore.appendEvents(evs);

        db.exec(`
            INSERT INTO incident_events (id, entity_id, incident_type, severity, trigger_metric, payload, created_at)
            VALUES ('inc_123', 'src/auth/auth.ts', 'TIMEOUT', 'HIGH', 'latency', '', '${now.toISOString()}')
        `);

        db.exec(`
            INSERT INTO incident_factors (factor_id, incident_id, factor_type, contribution_score)
            VALUES ('f1', 'inc_123', 'RUNTIME_DEGRADATION', 60),
                   ('f2', 'inc_123', 'RECURRING_RUNTIME_PATTERN', 85)
        `);

        rtBuilder = new RuntimeIntelligenceBuilder(db);
        incBuilder = new IncidentIntelligenceBuilder(db, incStore);

        intentRouter = new QueryIntentRouter('mock');
        
        // Use a wrapper to inject our memory db into the store
        evidenceStore = new RepositoryBrainEvidenceStore(':memory:');
        (evidenceStore as any).db = db;
        (evidenceStore as any).runtimeIntelligenceQueryEngine = new RuntimeIntelligenceQueryEngine(db);
        // Also inject into prediction accountability for tests if needed
    });

    it('Test 1: Which runtime components are unhealthy -> RuntimeIntelligenceQueryEngine response', async () => {
        await rtBuilder.build();
        const engine = new RuntimeIntelligenceQueryEngine(db);
        const unhealthy = engine.getUnhealthyComponents();
        
        expect(unhealthy.length).toBeGreaterThan(0);
        expect(unhealthy[0].component_id).toBe('auth');
        expect(unhealthy[0].status).toBe('DEGRADED');
    });

    it('Test 2: What runtime failures increased recently -> Runtime pattern summary', async () => {
        await rtBuilder.build();
        const engine = new RuntimeIntelligenceQueryEngine(db);
        const patterns = engine.getRecentPatternIncreases();
        
        expect(patterns.length).toBeGreaterThan(0);
        expect(patterns[0].component_id).toBe('auth');
        expect(patterns[0].pattern_type).toBe('TIMEOUT');
        expect(patterns[0].status).toBe('ACTIVE');
    });

    it('Test 3: Which files belong to degraded runtime components -> Join through runtime_repository_mappings', async () => {
        await rtBuilder.build();
        const engine = new RuntimeIntelligenceQueryEngine(db);
        const files = engine.getFilesForDegradedComponents();
        
        expect(files.length).toBeGreaterThan(0);
        expect(files[0].entity_id).toBe('src/auth/auth.ts');
        expect(files[0].component_id).toBe('auth');
        expect(files[0].status).toBe('DEGRADED');
    });

    it('Test 4: What runtime risks exist -> Runtime factors surfaced through Evidence Store', async () => {
        await rtBuilder.build();

        const engine = new RuntimeIntelligenceQueryEngine(db);
        const risks = engine.getRuntimeRisks();
        
        expect(risks.length).toBeGreaterThan(0);
        expect(risks.some(r => r.factor_type === 'RUNTIME_DEGRADATION')).toBe(true);
        expect(risks.some(r => r.factor_type === 'RECURRING_RUNTIME_PATTERN')).toBe(true);
    });

    it('Test 5: Missing runtime tables -> Graceful fallback. No planner failures.', () => {
        const emptyDb = new DatabaseSync(':memory:');
        const emptyEngine = new RuntimeIntelligenceQueryEngine(emptyDb);
        
        expect(emptyEngine.isAvailable()).toBe(false);
        expect(emptyEngine.getUnhealthyComponents()).toEqual([]);
        expect(emptyEngine.getRecentPatternIncreases()).toEqual([]);
        expect(emptyEngine.getFilesForDegradedComponents()).toEqual([]);
        expect(emptyEngine.getRuntimeRisks()).toEqual([]);
    });

    it('Test 6: MCP serialization -> Deterministic markdown payload', async () => {
        await rtBuilder.build();

        // 1. Router Classification
        const classification = intentRouter.classify("Which runtime components are degraded?");
        expect(classification.primary).toBe('RUNTIME_INTELLIGENCE');

        // 2. Planner
        const plan = buildEvidencePlan("Which runtime components are degraded?");
        expect(plan.queryType).toBe('runtime_intelligence');

        // 3. Evidence Store Execution
        const evidence = evidenceStore.execute(plan);
        expect(evidence.length).toBe(1);

        const md = evidence[0].content;
        expect(md).toContain('RUNTIME INTELLIGENCE');
        expect(md).toContain('Unhealthy Components:');
        expect(md).toContain('auth');
        expect(md).toContain('DEGRADED');
        expect(md).toContain('Active Patterns:');
        expect(md).toContain('TIMEOUT');
        expect(md).toContain('Impacted Files');
        expect(md).toContain('src/auth/auth.ts');
        expect(md).toContain('Runtime Risks (Incident Factors):');
        expect(md).toContain('RUNTIME_DEGRADATION');
        expect(md).toContain('RECURRING_RUNTIME_PATTERN');
    });
});
