import test from 'node:test';
import * as assert from 'node:assert/strict';
import { QueryDispatcher } from '../../query/queryDispatcher';
import { ConversationHistory } from '../../query/conversationHistory';
import { EvidenceAnswerSynthesizer } from '../../query/evidenceAnswerSynthesizer';
import { RepositoryContext } from '../../context/repositoryContext';
import { ExecutionPlan } from '../../query/executionPlanner';
import { FactRecord } from '../../indexing/factTypes';

/**
 * Proves Part A's scoping claim: the new MCP-only citation rank-and-cap
 * (citationRanker.ts's rankAndCapCitations, wired ONLY into mcpServer.ts's
 * ask_repoguide handler) does not touch queryDispatcher.ts's emitFinalAnswer
 * -- the function that builds `file_references` and is SHARED by chat and
 * MCP. Drives the real QueryDispatcher.query() generator (the same one
 * chat's webview consumes) with a plan that yields 30 real facts -- well
 * over MCP_CITATION_CAP (25) -- and asserts the emitted answerMetadata's
 * file_references contains all 30, uncapped and unranked, byte-identical to
 * what this code produced before Part A. If the cap had leaked into the
 * shared function, this test would see 25 or fewer and fail.
 */

function stubContext(): RepositoryContext {
    return {
        workspaceRoot: '/fake',
        repoguideDataDir: '/fake/.repoguide',
        getConfig: (_key: string, defaultValue?: unknown) => defaultValue as any,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined, debug: () => undefined, info: () => undefined,
            warn: () => undefined, error: () => undefined, stageStart: () => undefined,
            stageProgress: () => undefined, stageComplete: () => undefined, stageFailed: () => undefined,
            artifactWritten: () => undefined, queryLog: () => undefined, repairLog: () => undefined
        } as any,
        notifyInfo: () => undefined,
        notifyWarning: () => undefined,
        notifyError: () => undefined
    };
}

function makeExecutionPlanWithSymbolHint(question: string): ExecutionPlan {
    return {
        planId: 'p1',
        requestId: 'r1',
        query: question,
        category: 'general' as any,
        intent: {} as any,
        complexity: { score: 0, reasons: [] } as any,
        strategy: {} as any,
        retrievalPlan: {} as any,
        intelligencePlan: {} as any,
        evidenceRequirements: [],
        verificationPlan: { checkNumericClaims: true, checkQuotedStrings: true, checkFilePaths: true } as any,
        confidencePolicy: {} as any,
        freshnessPolicy: {} as any,
        failurePolicy: {} as any,
        diagnostics: [],
        metadata: { planner: 'regex' } as any,
        evidencePlan: {
            originalQuery: question,
            normalizedQuery: '',
            queryType: 'unknown',
            requiredEvidence: [],
            symbolHints: ['someSymbol'],
            fileHints: [],
            phrases: [],
            factTypes: [],
            unitTypes: [],
            fileScope: 'both',
            retrievalStrategy: 'exact_match',
            mustExcludeRoles: [],
            diagnostics: [],
            confidence_mode: 'exact'
        }
    };
}

function makeFactRecords(count: number): FactRecord[] {
    return Array.from({ length: count }, (_, i) => ({
        factId: `fact_${i}`,
        filePath: `src/fact_${i}.ts`,
        unitId: `unit_${i}`,
        symbol: `symbol_${i}`,
        factType: 'assignment',
        value: i,
        valueKind: 'number',
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: `const symbol_${i} = ${i};`,
        role: 'implementation'
    } as FactRecord));
}

function makeDispatcher(): QueryDispatcher {
    const stores = {
        unitStore: { searchBySymbol: async () => [] } as any,
        factStore: { findBySymbol: async () => makeFactRecords(30) } as any,
        bm25Store: { search: async () => [] } as any
    };
    const executionPlanner = { plan: async (request: { query: string }) => makeExecutionPlanWithSymbolHint(request.query) } as any;
    return new QueryDispatcher(
        new ConversationHistory(),
        stores,
        stubContext(),
        { executionPlanner, client: 'vscode' }
    );
}

function patchSynthesize(answer: string): () => void {
    const original = EvidenceAnswerSynthesizer.prototype.synthesize;
    EvidenceAnswerSynthesizer.prototype.synthesize = async () => answer;
    return () => {
        EvidenceAnswerSynthesizer.prototype.synthesize = original;
    };
}

test('chat/query()\'s emitted file_references is uncapped and unranked -- unaffected by the MCP-only citation cap', async () => {
    const restore = patchSynthesize('This is a plain, clean answer with nothing to verify against evidence.');
    try {
        const dispatcher = makeDispatcher();
        const tokens: string[] = [];
        for await (const token of dispatcher.query('some question')) {
            tokens.push(token);
        }

        const metadataToken = tokens.find(t => t.trim().startsWith('{"__type":"answerMetadata"'));
        assert.ok(metadataToken, `expected an answerMetadata token, got: ${JSON.stringify(tokens)}`);
        const parsed = JSON.parse(metadataToken!);

        // 30 facts in, 30 file_references out -- no cap of 25 (MCP_CITATION_CAP)
        // or any other truncation applied on the shared chat/MCP path.
        assert.equal(parsed.metadata.file_references.length, 30);
        // Unranked: original fact order preserved, not reordered by
        // answer-mention (this test's synthesized answer mentions none of them).
        assert.deepEqual(
            parsed.metadata.file_references.map((r: any) => r.file),
            Array.from({ length: 30 }, (_, i) => `src/fact_${i}.ts`)
        );
    } finally {
        restore();
    }
});
