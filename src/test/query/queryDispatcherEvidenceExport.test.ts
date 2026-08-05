import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QueryDispatcher } from '../../query/queryDispatcher';
import { ConversationHistory } from '../../query/conversationHistory';
import { EvidenceAnswerSynthesizer } from '../../query/evidenceAnswerSynthesizer';
import { RepositoryContext } from '../../context/repositoryContext';
import { ExecutionPlan } from '../../query/executionPlanner';
import { QUERY_EVIDENCE_FILENAME, readQueryEvidence } from '../../query/queryEvidenceExporter';

/**
 * Proves the actual claim, not just the surrounding code shape: a
 * gate-blocked single-shot refusal never writes a query-evidence export
 * (runEvidenceQuery's block branch returns BEFORE reaching emitFinalAnswer,
 * where the export call lives), while a real, delivered (non-blocked)
 * answer does. Drives the REAL QueryDispatcher.query() generator to
 * completion -- not a mock of runEvidenceQuery's control flow -- using a
 * deliberately degenerate ExecutionPlan/EvidencePlan (queryType: 'unknown',
 * every hint list empty) that makes EvidencePacketBuilder.buildPacket()
 * produce a real, empty packet without touching unitStore/factStore/
 * bm25Store at all (traced through evidencePacketBuilder.ts to confirm this
 * before relying on it -- every retrieval branch there is gated on a
 * non-empty hint/queryType this plan deliberately never satisfies). The
 * only monkey-patched piece is EvidenceAnswerSynthesizer.prototype.synthesize
 * (same technique as this week's axiosBranchControl.js scratchpad harness),
 * so the real AnswerGate.verify() genuinely decides block vs. not from real
 * verification rules on the synthesized text -- not a faked gate outcome.
 */

function stubContext(repoguideDataDir: string): RepositoryContext {
    return {
        workspaceRoot: repoguideDataDir,
        repoguideDataDir,
        getConfig: (_key: string, defaultValue?: unknown) => defaultValue as any,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: () => undefined,
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            stageStart: () => undefined,
            stageProgress: () => undefined,
            stageComplete: () => undefined,
            stageFailed: () => undefined,
            artifactWritten: () => undefined,
            queryLog: () => undefined,
            repairLog: () => undefined
        } as any,
        notifyInfo: () => undefined,
        notifyWarning: () => undefined,
        notifyError: () => undefined
    };
}

/** Deliberately degenerate: every retrieval-triggering condition in
 * EvidencePacketBuilder.buildPacket() is false for this plan, so it builds
 * a real, empty EvidencePacket without needing real unitStore/factStore/
 * bm25Store implementations. */
function makeDegenerateExecutionPlan(question: string): ExecutionPlan {
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
            symbolHints: [],
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

function makeDispatcher(repoguideDataDir: string): QueryDispatcher {
    const stores = { unitStore: {} as any, factStore: {} as any, bm25Store: {} as any };
    const executionPlanner = { plan: async (request: { query: string }) => makeDegenerateExecutionPlan(request.query) } as any;
    return new QueryDispatcher(
        new ConversationHistory(),
        stores,
        stubContext(repoguideDataDir),
        { executionPlanner, client: 'vscode' }
    );
}

async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
    const tokens: string[] = [];
    for await (const token of gen) {
        tokens.push(token);
    }
    return tokens;
}

function patchSynthesize(answer: string): () => void {
    const original = EvidenceAnswerSynthesizer.prototype.synthesize;
    EvidenceAnswerSynthesizer.prototype.synthesize = async () => answer;
    return () => {
        EvidenceAnswerSynthesizer.prototype.synthesize = original;
    };
}

function makeTempRepoguideDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-dispatcher-export-'));
}

/** Both shapes a withheld answer can take (see src/query/withheldAnswer.ts): retrieval found
 *  nothing, or it found code the answer could not be verified against. */
const WITHHELD_MARKERS = [
    "I don't have enough evidence",
    'could not verify'
];

test('a gate-blocked single-shot refusal writes no query-evidence export', async () => {
    const dir = makeTempRepoguideDir();
    const restore = patchSynthesize('The code says "definitelyNotInEvidenceAnywhere123" right here.');
    try {
        const dispatcher = makeDispatcher(dir);
        const tokens = await drain(dispatcher.query('What does this do?'));

        // Confirm we actually reached the real block branch, not just that no
        // file happens to exist for some unrelated reason.
        assert.ok(
            tokens.some(t => WITHHELD_MARKERS.some(m => t.includes(m))),
            `expected a blocked refusal in the token stream, got: ${JSON.stringify(tokens)}`
        );

        assert.ok(
            !fs.existsSync(path.join(dir, QUERY_EVIDENCE_FILENAME)),
            'a blocked refusal must never produce a query-evidence export file'
        );
    } finally {
        restore();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a real, delivered (non-blocked) answer DOES write a query-evidence export, with the right content', async () => {
    const dir = makeTempRepoguideDir();
    const restore = patchSynthesize('This is a plain, clean answer with nothing to verify against evidence.');
    try {
        const dispatcher = makeDispatcher(dir);
        const tokens = await drain(dispatcher.query('What does this do?'));

        assert.ok(
            !tokens.some(t => typeof t === 'string' && WITHHELD_MARKERS.some(m => t.includes(m))),
            'this answer must not be blocked -- the export assertion below only means something if delivery genuinely happened'
        );

        const entries = await readQueryEvidence(dir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].question, 'What does this do?');
        assert.equal(entries[0].client, 'vscode');
        assert.equal(entries[0].decomposed, false);
        // A clean answer (no quotes/numbers/paths to fail verification) against
        // an empty packet whose gaps field is genuinely empty (EvidencePacketBuilder
        // only threads truncation/retrieval-provider gaps into packet.gaps, not
        // the diagnostic-only structural-gap computation -- confirmed by this
        // real run, not assumed) passes real AnswerGate.verify() outright.
        assert.equal(entries[0].gateStatus.outcome, 'pass');
        assert.ok(entries[0].answer.includes('This is a plain, clean answer'));
    } finally {
        restore();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the eval-harness client ("internal") never writes an export, so evaluation runs do not pollute real chat/MCP history', async () => {
    const dir = makeTempRepoguideDir();
    const restore = patchSynthesize('This is a plain, clean answer with nothing to verify against evidence.');
    try {
        const stores = { unitStore: {} as any, factStore: {} as any, bm25Store: {} as any };
        const executionPlanner = { plan: async (request: { query: string }) => makeDegenerateExecutionPlan(request.query) } as any;
        const dispatcher = new QueryDispatcher(
            new ConversationHistory(),
            stores,
            stubContext(dir),
            { executionPlanner, client: 'internal' }
        );

        await drain(dispatcher.query('What does this do?'));

        assert.ok(!fs.existsSync(path.join(dir, QUERY_EVIDENCE_FILENAME)));
    } finally {
        restore();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
