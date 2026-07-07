import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HybridRetrievalFusion } from '../../query/hybridRetrievalFusion';
import { LanceStore } from '../../store/lanceStore';
import { Bm25Store } from '../../store/bm25Store';
import { CodeChunk } from '../../store/storeTypes';
import { RepositoryContext } from '../../context/repositoryContext';
import { IntentClassifier } from '../../query/intentClassifier';

/**
 * Real, live testing against CraftConnect found that HybridRetrievalFusion's
 * BM25 pass searches with the raw, full question text -- and Bm25Store's
 * tokenizer has no stopword handling, so MiniSearch's `combineWith: 'OR'`
 * scoring sums a contribution per matched token INCLUDING filler words
 * ("does", "have", "way"). A long prose document that incidentally contains
 * more of a natural-language question's filler words can outrank a short,
 * topically-precise file (a Dockerfile, a *.yaml config) that matches only
 * the load-bearing terms -- confirmed live: CraftConnect's real Dockerfile/
 * deployment/cloud_run_config.yaml ranked #1 for isolated keyword queries but
 * fell entirely outside the raw question's top 50 results. A small synthetic
 * corpus doesn't reliably reproduce that exact ranking dynamic (MiniSearch's
 * IDF weighting behaves differently at corpus scales this small), so these
 * tests instead verify the actual mechanism the fix relies on: a chunk with
 * ZERO vocabulary overlap with the raw question (so it is Boolean-absent from
 * the raw-question OR-combined search, regardless of scoring) becomes
 * reachable via the supplemental keyword-only pass, and the additive-only
 * guarantee -- every raw-question hit keeps its exact prior identity/order --
 * holds when queryTerms are supplied.
 */

async function makeTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function chunk(id: string, filePath: string, text: string): CodeChunk {
    return {
        id, filePath, language: 'text', startLine: 1, endLine: 1, text,
        vector: new Array(768).fill(0.01), hash: id
    };
}

function stubContext(): RepositoryContext {
    return {
        workspaceRoot: '/workspace',
        getConfig: (_key: string, defaultValue?: unknown) => defaultValue as any,
        asRelativePath: (p: string) => p,
        logger: {
            info: () => undefined,
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

async function makeFusion(dir: string): Promise<{ fusion: HybridRetrievalFusion; lance: LanceStore; bm25: Bm25Store }> {
    const lance = new LanceStore(dir);
    await lance.init();
    const bm25 = new Bm25Store(dir);
    await bm25.init();
    const fusion = new HybridRetrievalFusion(
        lance, bm25, dir, '/workspace',
        {} as IntentClassifier,
        stubContext()
    );
    return { fusion, lance, bm25 };
}

/** searchBm25 is a private implementation detail of HybridRetrievalFusion --
 * accessed directly here (the same pattern as testing any other private
 * method through a real instance) since it doesn't touch the network-backed
 * collaborators (IntentClassifier, StrategyRouter/Ollama) retrieveContext()
 * would otherwise require standing up. */
async function callSearchBm25(fusion: HybridRetrievalFusion, question: string, queryTerms: string[] = []): Promise<CodeChunk[]> {
    return (fusion as any).searchBm25(question, queryTerms);
}

test('keyword-only supplemental pass surfaces a chunk with zero raw-question vocabulary overlap', async () => {
    const dir = await makeTempDir('bm25-keyword-supplement');
    const { fusion, lance, bm25 } = await makeFusion(dir);

    const question = 'How does this project handle background job scheduling?';
    // "celery" shares no token with the question above -- Boolean-guaranteed
    // absent from a raw-question OR-combined search regardless of scoring,
    // mirroring the real Dockerfile/cloud_run_config.yaml case (a config file
    // whose vocabulary is disjoint from a natural-language question about it).
    const signal = chunk('signal-1', 'infra/celery_worker.yaml', 'celery worker configuration for async task queue');
    const other = chunk('other-1', 'docs/overview.md', 'This project explains how the system processes incoming requests end to end.');

    await lance.insertChunks([signal, other]);
    await bm25.insertChunks([signal, other]);

    const withoutKeywords = await callSearchBm25(fusion, question);
    assert.equal(withoutKeywords.some(c => c.id === 'signal-1'), false,
        'signal chunk must be absent from the raw-question-only search (no shared vocabulary)');

    const withKeywords = await callSearchBm25(fusion, question, ['celery']);
    assert.equal(withKeywords.some(c => c.id === 'signal-1'), true,
        'signal chunk must be surfaced once queryTerms include a term it actually contains');
});

test('the keyword-only pass is additive-only: every raw-question hit keeps its identity and order', async () => {
    const dir = await makeTempDir('bm25-keyword-additive');
    const { fusion, lance, bm25 } = await makeFusion(dir);

    const question = 'How does this project handle background job scheduling?';
    const chunks = [
        chunk('bg-1', 'app/scheduler.py', 'Background job scheduling is handled by a cron-based dispatcher in this project.'),
        chunk('bg-2', 'app/jobs.py', 'This project defines background jobs that run on a schedule.'),
        chunk('signal-1', 'infra/celery_worker.yaml', 'celery worker configuration for async task queue')
    ];
    await lance.insertChunks(chunks);
    await bm25.insertChunks(chunks);

    const withoutKeywords = await callSearchBm25(fusion, question);
    const withKeywords = await callSearchBm25(fusion, question, ['celery']);

    assert.ok(withoutKeywords.length > 0, 'sanity: the raw-question search must find the on-topic chunks');
    assert.deepEqual(
        withKeywords.slice(0, withoutKeywords.length).map(c => c.id),
        withoutKeywords.map(c => c.id),
        'the supplemental pass must not reorder or displace any raw-question hit'
    );
    assert.equal(withKeywords.some(c => c.id === 'signal-1'), true);
});

test('an empty queryTerms array behaves exactly like the pre-fix single-pass search', async () => {
    const dir = await makeTempDir('bm25-keyword-empty');
    const { fusion, lance, bm25 } = await makeFusion(dir);

    const question = 'How does this project handle background job scheduling?';
    const chunks = [chunk('bg-1', 'app/scheduler.py', 'Background job scheduling is handled by a cron-based dispatcher in this project.')];
    await lance.insertChunks(chunks);
    await bm25.insertChunks(chunks);

    const noArgResults = await callSearchBm25(fusion, question);
    const emptyArrayResults = await callSearchBm25(fusion, question, []);
    assert.deepEqual(emptyArrayResults.map(c => c.id), noArgResults.map(c => c.id));
});

test('a supplemental keyword search failure does not fail the primary raw-question results', async () => {
    const dir = await makeTempDir('bm25-keyword-supplement-failure');
    const { fusion, lance, bm25 } = await makeFusion(dir);

    const question = 'How does this project handle background job scheduling?';
    const chunks = [chunk('bg-1', 'app/scheduler.py', 'Background job scheduling is handled by a cron-based dispatcher in this project.')];
    await lance.insertChunks(chunks);
    await bm25.insertChunks(chunks);

    // Force the supplemental pass to throw by breaking the underlying search
    // after the primary pass has already run -- simulates a real transient
    // failure on the second, best-effort call.
    const originalSearch = bm25.search.bind(bm25);
    let callCount = 0;
    (bm25 as any).search = async (query: string, topK?: number) => {
        callCount++;
        if (callCount === 2) {
            throw new Error('simulated transient BM25 failure on supplemental pass');
        }
        return originalSearch(query, topK);
    };

    const results = await callSearchBm25(fusion, question, ['scheduling']);
    assert.equal(results.some(c => c.id === 'bg-1'), true, 'primary results must still be returned when the supplemental pass fails');
});
