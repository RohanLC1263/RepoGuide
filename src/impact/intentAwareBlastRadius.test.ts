import { DatabaseSync } from 'node:sqlite';
import { describe, test, expect, beforeEach } from '@jest/globals';
import { ProgramGraphStore } from '../store/programGraphStore';
import { ADRCodeLinkStore } from '../intent/linking/adrCodeLinkStore';
import { IntentStore } from '../intent/extraction/intentStore';
import { IntentGraphQueryEngine } from '../intent/graph/intentGraphQueryEngine';
import { IntentQueryEngine } from '../intent/extraction/intentQueryEngine';
import { IntentAwareBlastRadiusStore } from './intentAwareBlastRadiusStore';
import { IntentAwareBlastRadiusEngine } from './intentAwareBlastRadiusEngine';
import { GovernanceScorer } from './governanceScorer';
import { IntentGraphStore } from '../intent/graph/intentGraphStore';

describe('Intent-Aware Blast Radius Engine', () => {
    let db: DatabaseSync;
    let graphStore: ProgramGraphStore;
    let adrLinkStore: ADRCodeLinkStore;
    let intentStore: IntentStore;
    let intentQueryEngine: IntentQueryEngine;
    let intentGraphStore: IntentGraphStore;
    let intentGraphQuery: IntentGraphQueryEngine;
    let impactStore: IntentAwareBlastRadiusStore;
    let engine: IntentAwareBlastRadiusEngine;

    beforeEach(() => {
        db = new DatabaseSync(':memory:');
        
        graphStore = new ProgramGraphStore();
        (graphStore as any).version = 'test_v1';
        (graphStore as any).graph = {
            version: "1", builtAt: "now", nodeCount: 3, edgeCount: 2,
            nodes: {}, edges: []
        };
        
        adrLinkStore = new ADRCodeLinkStore(db);
        intentStore = new IntentStore(db);
        intentQueryEngine = new IntentQueryEngine(intentStore);
        intentGraphStore = new IntentGraphStore(db);
        intentGraphQuery = new IntentGraphQueryEngine(intentGraphStore, intentQueryEngine);
        impactStore = new IntentAwareBlastRadiusStore(db);
        
        engine = new IntentAwareBlastRadiusEngine(
            graphStore,
            adrLinkStore,
            intentStore,
            intentGraphQuery,
            impactStore
        );
    });

    const addGraphNode = (node: any) => {
        (graphStore as any).graph.nodes[node.id] = node;
    };
    const addGraphEdge = (edge: any) => {
        (graphStore as any).graph.edges.push(edge);
        if (!(graphStore as any).inEdges.has(edge.to)) (graphStore as any).inEdges.set(edge.to, []);
        (graphStore as any).inEdges.get(edge.to).push(edge);
    };

    test('Computes structural impact and resolves intents without score inflation', async () => {
        // Setup mock structure
        addGraphNode({ id: 'core-util', symbol: 'Logger', filePath: 'logger.ts' });
        addGraphNode({ id: 'app-svc', symbol: 'AppSvc', filePath: 'app.ts' });
        addGraphNode({ id: 'auth-svc', symbol: 'AuthSvc', filePath: 'auth.ts' });
        
        // AppSvc and AuthSvc use core-util
        addGraphEdge({ from: 'app-svc', to: 'core-util', type: 'reads' });
        addGraphEdge({ from: 'auth-svc', to: 'core-util', type: 'reads' });

        // Setup mock ADR Links
        // AppSvc is governed by ADR-1
        adrLinkStore.saveBatch(new Map([
            ['l1', { id: 'l1', adrId: 'ADR-1', nodeId: 'app-svc', relationshipType: 'GOVERNS', confidence: 1.0, evidenceCount: 1, score: 10 }],
            ['l2', { id: 'l2', adrId: 'ADR-2', nodeId: 'auth-svc', relationshipType: 'GOVERNS', confidence: 1.0, evidenceCount: 1, score: 10 }]
        ]), []);

        // Setup mock Intents
        const intentMap = new Map();
        intentMap.set('intent-logging', {
            id: 'intent-logging',
            type: 'RELIABILITY',
            canonicalTopic: 'Logging',
            confidence: 1.0,
            evidenceCount: 1,
            adrCount: 1,
            prCount: 0,
            commitCount: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date()
        });
        intentMap.set('intent-auth', {
            id: 'intent-auth',
            type: 'SECURITY',
            canonicalTopic: 'Authentication',
            confidence: 1.0,
            evidenceCount: 1,
            adrCount: 1,
            prCount: 0,
            commitCount: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date()
        });
        intentMap.set('intent-crypto', {
            id: 'intent-crypto',
            type: 'SECURITY',
            canonicalTopic: 'Cryptography',
            confidence: 1.0,
            evidenceCount: 1,
            adrCount: 0,
            prCount: 0,
            commitCount: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date()
        });

        await intentStore.saveBatch(intentMap, [
            { intentId: 'intent-logging', sourceId: 'ADR-1', sourceType: 'ADR', snippet: '', createdAt: new Date() },
            { intentId: 'intent-auth', sourceId: 'ADR-2', sourceType: 'ADR', snippet: '', createdAt: new Date() }
        ]);
        db.prepare(`
            INSERT INTO intent_graph_edges (id, source_intent_id, target_intent_id, relationship_type, weight, confidence)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('edge1', 'intent-auth', 'intent-crypto', 'REQUIRES', 3, 1.0);

        // RUN ENGINE
        const impact = await engine.analyzeNode('core-util');

        expect(impact.rootNodeId).toBe('core-util');
        // Nodes impacted structurally: core-util (itself), app-svc, auth-svc
        expect(impact.impactedNodeIds.sort()).toEqual(['app-svc', 'auth-svc', 'core-util']);
        
        // ADRs impacted: ADR-1, ADR-2
        expect(impact.impactedADRIds.sort()).toEqual(['ADR-1', 'ADR-2']);
        
        // Intents impacted: Logging, Authentication
        expect(impact.impactedIntentIds.sort()).toEqual(['intent-auth', 'intent-logging']);
        
        // Neighbors: Cryptography
        expect(impact.impactedNeighborIntentIds).toEqual(['intent-crypto']);

        // Score check: 2 ADRs (20), 2 Intents (10), 1 Neighbor (2) = 32
        expect(impact.governanceScore).toBe(32);
        expect(impact.governanceSeverity).toBe('HIGH');
    });

    test('Cache mechanism retrieves exact previous impact if version matches', async () => {
        // Just compute an empty node
        addGraphNode({ id: 'isolated', symbol: 'Iso', filePath: 'iso.ts' });

        const impact1 = await engine.analyzeNode('isolated');
        expect(impact1.governanceScore).toBe(0);

        // If we call again, we get the cached copy
        const impact2 = await engine.analyzeNode('isolated');
        expect(impact1.id).toBe(impact2.id); // Same impact object id
    });
});
