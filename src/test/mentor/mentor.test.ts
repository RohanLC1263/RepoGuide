import * as assert from 'assert';

import { ContextNormalizer } from '../../query/contextNormalizer';
import { MentorContextAdapter } from '../../mentor/mentorContextAdapter';
import { MentorEngine } from '../../mentor/mentorEngine';
import { EvidencePacket } from '../../query/evidencePacket';
import { ChangeRecommendation, RefactoringRecommendation, ArchitectureRecommendation, OnboardingRecommendation } from '../../mentor/mentorTypes';

suite('Mentor Foundations', () => {

    test('ContextNormalizer + MentorContextAdapter: extracts data correctly', () => {
        const mockPacket: any = {
            query: 'test query',
            plan: {
                queryType: 'impact_analysis',
                confidence_mode: 'grounded',
                requiredEvidence: [],
                symbolHints: [],
                fileHints: []
            },
            items: [
                { id: '1', file: 'a.ts', type: 'annotation', retrieval_signal: 'annotation_enrichment', semanticCategory: 'ARCHITECTURE', content: 'Annotation 1' },
                { id: '2', file: 'b.ts', type: 'community_summary', retrieval_signal: 'community_summary', semanticCategory: 'COMMUNITY', content: 'Community 1' },
                { id: '3', file: 'c.ts', type: 'class', retrieval_signal: 'graph_dependent_expansion', semanticCategory: 'DEPENDENCY', content: 'Dep 1' },
                { id: '4', file: 'd.ts', type: 'function', retrieval_signal: 'semantic_search', semanticCategory: 'BEHAVIOR', content: 'Logic 1' }
            ],
            facts: [],
            diagnostics: [],
            coverageScore: 0.8
        };

        const normalizer = new ContextNormalizer();
        const adapter = new MentorContextAdapter();
        const bundle = normalizer.normalize(mockPacket, 'change_mentor');
        const context = adapter.adapt(bundle);
        
        assert.strictEqual(context.capability, 'change_mentor');
        assert.strictEqual(context.architecturalEvidence.length, 1);
        assert.strictEqual(context.architecturalEvidence[0].content, 'Annotation 1');
        assert.strictEqual(context.communityEvidence.length, 1);
        assert.strictEqual(context.communityEvidence[0].content, 'Community 1');
        assert.strictEqual(context.dependencyEvidence.length, 1);
        assert.strictEqual(context.dependencyEvidence[0].content, 'Dep 1');
        assert.strictEqual(context.behavioralEvidence.length, 1);
        assert.strictEqual(context.behavioralEvidence[0].content, 'Logic 1');
    });

    test('MentorEngine: evaluates Architecture Recommendation with Importance Scoring', () => {
        const engine = new MentorEngine();
        
        const context: any = {
            capability: 'architecture_mentor',
            communityEvidence: [
                { file: 'main.ts', symbol: 'CoreApp', content: 'app' },
                { file: 'main.ts', symbol: 'CoreApp', content: 'app2' },
                { file: 'util.ts', symbol: 'Helper', content: 'util' }
            ],
            architecturalEvidence: [
                { file: 'main.ts', symbol: 'CoreApp', content: 'annot 1' }
            ],
            dependencyEvidence: []
        };

        const result = engine.process(context);
        const rec = result.recommendation as ArchitectureRecommendation;
        
        assert.strictEqual(rec.type, 'architecture');
        assert.strictEqual(rec.importantFiles[0], 'main.ts'); // Higher frequency (3 occurrences vs 1)
        assert.strictEqual(rec.majorComponents[0], 'CoreApp'); // Higher frequency
    });

    test('MentorEngine: evaluates Onboarding Recommendation with Learning Path', () => {
        const engine = new MentorEngine();
        
        const context: any = {
            capability: 'onboarding_mentor',
            communityEvidence: [
                { file: 'src/main.ts', symbol: 'Entry' },
                { file: 'src/router/api.ts', symbol: 'API' },
                { file: 'src/services/auth.ts', symbol: 'Auth' },
                { file: 'src/components/ui/button.ts', symbol: 'UI' }
            ],
            architecturalEvidence: [],
            dependencyEvidence: []
        };

        const result = engine.process(context);
        const rec = result.recommendation as OnboardingRecommendation;
        
        assert.strictEqual(rec.type, 'onboarding');
        assert.strictEqual(rec.learningPath[0], 'src/main.ts'); // Entry Points
        assert.strictEqual(rec.learningPath[1], 'src/router/api.ts'); // Core Routing
        assert.strictEqual(rec.learningPath[2], 'src/services/auth.ts'); // Domain Logic
        assert.strictEqual(rec.learningPath[3], 'src/components/ui/button.ts'); // Specialized
    });

    test('MentorEngine: evaluates ChangeRecommendation with Risk Scoring', () => {
        const engine = new MentorEngine();
        
        // 5 dependencies, 1 unique file, max symbol freq = 5 -> score = 5 * 1 * 5 = 25 (MEDIUM)
        const context: any = {
            capability: 'change_mentor',
            dependencyEvidence: [
                { file: 'a.ts', symbol: 'A', content: 'Impact 1' },
                { file: 'a.ts', symbol: 'A', content: 'Impact 2' },
                { file: 'a.ts', symbol: 'A', content: 'Impact 3' },
                { file: 'a.ts', symbol: 'A', content: 'Impact 4' },
                { file: 'a.ts', symbol: 'A', content: 'Impact 5' }
            ],
            communityEvidence: [], architecturalEvidence: []
        };

        const result = engine.process(context);
        const rec = result.recommendation as ChangeRecommendation;
        assert.strictEqual(rec.type, 'change');
        assert.strictEqual(rec.affectedFiles.length, 1);
        assert.strictEqual(rec.riskLevel, 'MEDIUM'); 
    });

    test('MentorEngine: evaluates RefactoringRecommendation warnings and hotspots correctly', () => {
        const engine = new MentorEngine();
        
        const deps = [];
        // Create 10 dependencies to trigger hotspot
        for(let i=0; i<10; i++) {
            deps.push({ file: 'god_object.ts', startLine: 1, endLine: 600, content: `Huge Object ${i}` });
        }

        const context: any = {
            capability: 'refactoring_mentor',
            dependencyEvidence: deps,
            communityEvidence: [], architecturalEvidence: []
        };

        const result = engine.process(context);
        const rec = result.recommendation as RefactoringRecommendation;
        assert.strictEqual(rec.type, 'refactoring');
        assert.strictEqual(rec.largeModules.length, 1);
        assert.strictEqual(rec.largeModules[0], 'god_object.ts');
        assert.strictEqual(rec.hotspots.length, 1);
        assert.strictEqual(rec.hotspots[0], 'god_object.ts');
    });
});
