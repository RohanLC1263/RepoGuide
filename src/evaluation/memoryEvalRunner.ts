import { MemoryEvalExpectations, MemoryEvalReport, MemoryGateResults } from './memoryGoldenTypes';
import { ContextNormalizer } from '../query/contextNormalizer';
import { MentorContextAdapter } from '../mentor/mentorContextAdapter';
import { EvidencePacket, SemanticCategory } from '../query/evidencePacket';
import { MentorContext } from '../mentor/mentorTypes';
import { TestEmbeddingProvider } from '../memory/embeddings/testEmbeddingProvider';
import { LanceDbMemoryStore } from '../memory/lanceDbMemoryStore';
import { LanceDbMemoryRetriever } from '../memory/lanceDbMemoryRetriever';
import * as fs from 'fs';

export interface MockMemoryRecord {
    id: string;
    content: string;
    scope: string;
    stale: boolean;
    provenance: { authorType: string; timestamp: string; };
}

export interface MemoryEvalTestCase {
    id: string;
    query: string;
    seededMemory: MockMemoryRecord[];
    expectations: MemoryEvalExpectations;
}

export class MemoryEvalRunner {
    private testCases: MemoryEvalTestCase[] = [];

    public addTest(test: MemoryEvalTestCase) {
        this.testCases.push(test);
    }

    public async run(): Promise<MemoryEvalReport> {
        console.log(`Running ${this.testCases.length} Memory Evaluation Tests...`);
        let passed = 0;
        let failed = 0;

        const gates: MemoryGateResults = {
            safetyPass: true,
            routingPass: true,
            stalenessPass: true,
            provenancePass: true,
            liftPass: true
        };

        const normalizer = new ContextNormalizer();
        const adapter = new MentorContextAdapter();

        // 1. Initialize LanceDB backend and Test Embeddings
        const dbPath = '.repoguide/lancedb_eval';
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { recursive: true, force: true });
        }
        const embeddingProvider = new TestEmbeddingProvider();
        const memoryStore = new LanceDbMemoryStore(embeddingProvider, dbPath);
        const memoryRetriever = new LanceDbMemoryRetriever(memoryStore);

        for (const test of this.testCases) {
            console.log(`Evaluating Test: ${test.id} - "${test.query}"`);
            
            const capability = (test.expectations.expectedMentorCapability || 'change_mentor') as string;
            const repoId = `test-repo-${test.id}`;

            // 1. Simulate Baseline Run
            const baselinePacket = this.buildBasePacket(test.query);
            const baselineBundle = normalizer.normalize(baselinePacket, capability);
            const baselineContext = adapter.adapt(baselineBundle);
            const baselineOutput = this.mockMentorExecution(baselineContext, false);

            // 2. Seed LanceDB
            let validMemoryCount = 0;
            for (const mem of test.seededMemory) {
                // Determine valid counts based on expectations for test validation
                if (!(mem.stale && test.expectations.expectedStaleMemoryBehavior === 'reject')) {
                    validMemoryCount++;
                }
                await memoryStore.create({
                    repositoryId: repoId,
                    content: mem.content,
                    scope: mem.scope,
                    scopeKeys: [],
                    tags: [],
                    stale: mem.stale,
                    provenance: mem.provenance
                });
            }

            // 3. Retrieve Memory via Unified LanceDB Retriever
            const retrievedMemories = await memoryRetriever.retrieve({
                repositoryIds: [repoId],
                textQuery: test.query,
                includeStale: test.expectations.expectedStaleMemoryBehavior !== 'reject'
            });

            // 4. Simulate Memory Run
            const memoryPacket = this.buildBasePacket(test.query);
            for (const mem of retrievedMemories) {
                memoryPacket.items.push({
                    id: mem.id,
                    file: 'memory',
                    startLine: 1,
                    endLine: 1,
                    role: 'unknown' as any,
                    type: 'memory',
                    content: mem.content,
                    retrieval_signal: mem.scope,
                    semanticCategory: SemanticCategory.MEMORY,
                    score: 1.0,
                    confidence: 1.0,
                    extractionMethod: 'lancedb',
                    stale: mem.stale
                });
            }

            const memoryBundle = normalizer.normalize(memoryPacket, capability);
            const memoryContext = adapter.adapt(memoryBundle);
            const memoryOutput = this.mockMentorExecution(memoryContext, true);

            // Evaluate Gates
            const result = this.evaluatePipeline(test, validMemoryCount, memoryContext, baselineOutput, memoryOutput);

            if (result.success) {
                passed++;
            } else {
                failed++;
                if (result.failureType === 'routing') gates.routingPass = false;
                if (result.failureType === 'safety') gates.safetyPass = false;
                if (result.failureType === 'staleness') gates.stalenessPass = false;
                if (result.failureType === 'provenance') gates.provenancePass = false;
                if (result.failureType === 'lift') gates.liftPass = false;
            }
        }

        return {
            timestamp: new Date().toISOString(),
            totalTests: this.testCases.length,
            passed,
            failed,
            gates
        };
    }

    private buildBasePacket(query: string): EvidencePacket {
        return {
            query,
            plan: {} as any,
            items: [
                {
                    id: 'base1',
                    file: 'app.ts',
                    startLine: 1,
                    endLine: 10,
                    role: 'unknown' as any,
                    type: 'dependency',
                    content: 'app.ts depends on db.ts',
                    retrieval_signal: 'test',
                    semanticCategory: SemanticCategory.DEPENDENCY,
                    score: 1.0,
                    confidence: 1.0,
                    extractionMethod: 'mock'
                }
            ],
            facts: [],
            coverage: [],
            gaps: [],
            diagnostics: [],
            coverageScore: 1.0,
            matchedEvidenceTypes: []
        };
    }

    private mockMentorExecution(context: MentorContext, useMemory: boolean): any {
        const hasMemory = useMemory && context.memoryEvidence && context.memoryEvidence.length > 0;
        
        if (context.capability === 'change_mentor') {
            if (hasMemory) {
                return {
                    riskLevel: 'MEDIUM',
                    reason: context.memoryEvidence[0].content,
                    dependents: 2
                };
            }
            return {
                riskLevel: 'LOW',
                dependents: 2
            };
        } else if (context.capability === 'onboarding_mentor') {
            if (hasMemory) {
                return {
                    firstFiles: ['audit.ts', 'index.ts', 'app.ts']
                };
            }
            return {
                firstFiles: ['index.ts', 'app.ts']
            };
        }
        
        return { mock: true, usedMemory: hasMemory };
    }

    private evaluatePipeline(test: MemoryEvalTestCase, validMemoryCount: number, memoryContext: MentorContext, baselineOutput: any, memoryOutput: any): { success: boolean, failureType?: string } {
        // 1. Staleness Validation
        const expectedCount = test.expectations.expectedMemoryCount ?? validMemoryCount;
        if (memoryContext.memoryEvidence.length !== expectedCount) {
            return { success: false, failureType: 'staleness' };
        }

        // 2. Context Presence (Level 1 Lift / Plumbing)
        if (expectedCount > 0 && memoryContext.memoryEvidence.length === 0) {
            return { success: false, failureType: 'lift' };
        }

        // 3. Provenance Validation
        const allMemorySemantics = memoryContext.memoryEvidence.every(m => m.category === SemanticCategory.MEMORY);
        if (!allMemorySemantics) {
            return { success: false, failureType: 'provenance' };
        }

        // 4. Context Utilization & Lift (Level 2 & Level 3 Lift)
        const baselineStr = JSON.stringify(baselineOutput);
        const memoryStr = JSON.stringify(memoryOutput);
        
        if (expectedCount > 0) {
            if (baselineStr === memoryStr) {
                return { success: false, failureType: 'lift' };
            }
            
            if (memoryStr.length <= baselineStr.length && !memoryStr.includes('MEDIUM')) {
                return { success: false, failureType: 'lift' };
            }
        }

        // 5. Routing validation (mock check)
        if (test.expectations.expectedRoutingBehavior === 'override_rejected') {
            return { success: false, failureType: 'routing' };
        }

        return { success: true };
    }
}
