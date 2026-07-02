import { expect, test, describe, beforeEach, afterEach } from '@jest/globals';
import { ADRCodeLinkStore } from './adrCodeLinkStore';
import { ADRCodeLinkBuilder } from './adrCodeLinkBuilder';
import { ADRCodeQueryEngine } from './adrCodeQueryEngine';
import { ADRStore } from '../adr/adrStore';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { IntentStore } from '../extraction/intentStore';
import { IntentQueryEngine } from '../extraction/intentQueryEngine';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { FactStore } from '../../store/factStore';

describe('ADR-to-Code Linking Engine', () => {
    let adrStore: ADRStore;
    let adrQueryEngine: ADRQueryEngine;
    let intentStore: IntentStore;
    let intentQueryEngine: IntentQueryEngine;
    let graphStore: ProgramGraphStore;
    
    let linkStore: ADRCodeLinkStore;
    let builder: ADRCodeLinkBuilder;
    let queryEngine: ADRCodeQueryEngine;

    beforeEach(async () => {
        adrStore = new ADRStore(':memory:');
        adrQueryEngine = new ADRQueryEngine(adrStore);
        
        intentStore = new IntentStore(':memory:');
        intentQueryEngine = new IntentQueryEngine(intentStore);

        // We need a dummy ProgramGraphStore.
        // It exposes graph.nodes when loaded, but we can mock it or use unit store builder.
        // Easiest is to mock the `getNodeMap` / `nodes` dictionary directly on instance.
        graphStore = new ProgramGraphStore();
        (graphStore as any).graph = {
            nodes: {
                'node-auth-svc': {
                    id: 'node-auth-svc',
                    symbol: 'AuthenticationService',
                    filePath: 'src/auth/AuthenticationService.ts',
                    type: 'class'
                },
                'node-util': {
                    id: 'node-util',
                    symbol: 'StringUtils',
                    filePath: 'src/utils/StringUtils.ts',
                    type: 'class'
                }
            }
        };
        // Mock getNode for QueryEngine
        graphStore.getNode = (id: string) => (graphStore as any).graph.nodes[id];

        linkStore = new ADRCodeLinkStore(intentStore.getDatabase());
        builder = new ADRCodeLinkBuilder(linkStore, graphStore, adrQueryEngine, intentQueryEngine);
        queryEngine = new ADRCodeQueryEngine(linkStore, adrQueryEngine, graphStore);
    });

    afterEach(() => {
        adrStore.close();
        intentStore.close();
    });

    test('Builder generates INTENT_MATCH, SYMBOL_MATCH, and PATH_MATCH with accumulative scoring', async () => {
        // Setup ADR
        await adrStore.save({
            id: 'adr-12',
            title: 'Use OAuth2 Authentication',
            status: 'ACCEPTED',
            context: 'We need auth.',
            decision: 'Use AuthenticationService inside src/auth.',
            consequences: 'More secure.',
            sourcePath: 'docs/adr/001.md',
            sourceHash: 'hash',
            repositoryId: 'r1',
            parserConfidence: 'HIGH',
            rawContent: 'Use AuthenticationService inside src/auth.'
        }, []);

        // Setup Intent Evidence linking ADR-12 to canonical "Authentication"
        await intentStore.saveBatch(new Map([
            ['intent-auth', {
                id: 'intent-auth',
                type: 'SECURITY',
                canonicalTopic: 'Authentication',
                confidence: 1.0,
                evidenceCount: 1, adrCount: 1, prCount: 0, commitCount: 0,
                firstSeenAt: new Date(), lastSeenAt: new Date()
            }]
        ]), [
            {
                intentId: 'intent-auth',
                sourceType: 'ADR',
                sourceId: 'adr-12',
                snippet: 'Authentication',
                createdAt: new Date()
            }
        ]);

        await builder.build();

        const governed = queryEngine.getGovernedNodes('adr-12');
        expect(governed.length).toBe(1); // Should only match node-auth-svc

        const result = governed[0];
        expect(result.node.id).toBe('node-auth-svc');

        // Verify score accumulation:
        // INTENT_MATCH for "Authentication" mapped to ADR (Score 5)
        // SYMBOL_MATCH for "AuthenticationService" text in ADR (Score 10)
        // PATH_MATCH for "auth" in ADR text matching path "src/auth/" (Score 3)
        // PATH_MATCH for "authenticationservice" (Score 3)
        // PATH_MATCH for "src" (Score 3)
        // Total Score = 24!
        
        expect(result.link.score).toBe(24);
        expect(result.link.confidence).toBe(1.0);
        
        // Verify multiple evidence pieces
        expect(result.evidence.length).toBe(5);
    });

    test('Threshold filters weak links (Score < 5)', async () => {
        await adrStore.save({
            id: 'adr-weak',
            title: 'Format strings',
            status: 'ACCEPTED',
            context: 'Strings',
            decision: 'Use src for strings', // Hits "src" path matches
            consequences: '',
            sourcePath: 'docs/adr/002.md',
            sourceHash: 'hash',
            repositoryId: 'r1',
            parserConfidence: 'HIGH',
            rawContent: 'Use src for strings'
        }, []);

        // No intent mapping. Path match gives 3 points for 'src'. Total 3 points. Threshold is 5.
        
        await builder.build();
        
        const governed = queryEngine.getGovernedNodes('adr-weak');
        expect(governed.length).toBe(0);
    });

    test('Rebuild idempotency', async () => {
        await adrStore.save({
            id: 'adr-12',
            title: 'Use AuthenticationService',
            status: 'ACCEPTED',
            context: '', decision: '', consequences: '',
            sourcePath: 'docs/adr/001.md', sourceHash: 'hash', repositoryId: 'r1',
            parserConfidence: 'HIGH', rawContent: 'AuthenticationService'
        }, []);

        await builder.build();
        await builder.build(); // Second rebuild

        const links = linkStore.getLinksForADR('adr-12');
        expect(links.length).toBe(1); // Should not duplicate the link
        
        const evs = linkStore.getEvidenceForLink(links[0].id);
        // Expect SYMBOL match (10) and potentially AuthenticationService path match if tokenized differently
        expect(evs.length).toBeGreaterThanOrEqual(1); 
    });
});
