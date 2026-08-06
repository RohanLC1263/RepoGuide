import test from 'node:test';
import * as assert from 'node:assert/strict';
import { QueryDispatcher } from '../../query/queryDispatcher';
import { ConversationHistory } from '../../query/conversationHistory';
import { RepositoryContext } from '../../context/repositoryContext';

/**
 * P1-2. `getPresentTechnologies()` memoises which technologies exist in the repo, which is
 * the right design -- it keeps `AnswerGate.verify()` synchronous, and presence is a
 * property of the repository rather than of any one question.
 *
 * The defect was the memo's LIFETIME: nothing cleared it, so "resolve once" meant once per
 * extension session rather than once per index generation. Add a real dependency, reindex
 * without reloading the window, and the technology-fabrication check compares a TRUE claim
 * against a snapshot taken before that dependency existed -- and it HARD BLOCKS. That is
 * the false-block class this project has already reverted checks for twice, arriving
 * through cache staleness instead of through the matcher.
 *
 * These tests drive the real QueryDispatcher and assert all three properties that matter,
 * because only asserting the third would pass just as well against a dispatcher that had
 * no cache at all:
 *   1. the cache genuinely caches (no re-resolution without invalidation),
 *   2. it genuinely goes stale (the bug is real, not hypothetical),
 *   3. invalidation genuinely clears it.
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
    } as any;
}

/**
 * Stands in for the BM25 store the dispatcher uses as its presence lookup. `indexed` is
 * mutable so a test can simulate the exact real-world sequence: reindex after a dependency
 * is genuinely added to the repository.
 */
function stubIndex(indexed: Set<string>) {
    let searchCalls = 0;
    return {
        store: {
            search: async (query: string, _max: number) => {
                searchCalls++;
                return indexed.has(query) ? [{ filePath: `src/uses_${query}.ts` }] : [];
            }
        },
        get searchCalls() { return searchCalls; }
    };
}

function makeDispatcher(bm25Store: unknown): QueryDispatcher {
    return new QueryDispatcher(
        new ConversationHistory(),
        { bm25Store } as any,
        stubContext(),
        { client: 'vscode' } as any
    );
}

/** The memo is private; these tests exercise it through the one public door plus a cast. */
const resolve = (d: QueryDispatcher): Promise<Set<string>> =>
    (d as any).getPresentTechnologies();

test('the technology-presence set is cached: a second answer does not re-scan the index', async () => {
    const index = stubIndex(new Set(['Django']));
    const dispatcher = makeDispatcher(index.store);

    const first = await resolve(dispatcher);
    const callsAfterFirst = index.searchCalls;
    const second = await resolve(dispatcher);

    assert.ok(callsAfterFirst > 0, 'the first resolution must actually scan the index');
    assert.equal(index.searchCalls, callsAfterFirst, 'a cached resolution must not re-scan');
    assert.equal(second, first, 'the same Set instance should be handed back');
});

test('STALENESS REPRODUCTION: without invalidation, a newly-indexed technology stays invisible', async () => {
    const indexed = new Set(['Django']);
    const index = stubIndex(indexed);
    const dispatcher = makeDispatcher(index.store);

    const before = await resolve(dispatcher);
    assert.equal(before.has('Redis'), false, 'Redis is genuinely absent to begin with');

    // The user adds a real Redis dependency and reindexes -- but nothing tells the
    // dispatcher, which is precisely the bug.
    indexed.add('Redis');

    const after = await resolve(dispatcher);
    assert.equal(
        after.has('Redis'), false,
        'this assertion DOCUMENTS THE DEFECT: the stale snapshot still reports Redis absent, ' +
        'which is what made the gate hard-block a correct answer about a real dependency.'
    );
});

test('invalidatePresentTechnologies makes the next answer see the reindexed technology', async () => {
    const indexed = new Set(['Django']);
    const index = stubIndex(indexed);
    const dispatcher = makeDispatcher(index.store);

    await resolve(dispatcher);
    indexed.add('Redis');
    dispatcher.invalidatePresentTechnologies();
    const after = await resolve(dispatcher);

    assert.equal(after.has('Redis'), true, 'the re-resolved set must include the newly-indexed technology');
    assert.equal(after.has('Django'), true, 'previously-present technologies must survive re-resolution');
});

test('invalidation does not disable the check: a genuinely absent technology stays absent', async () => {
    const indexed = new Set(['Django']);
    const index = stubIndex(indexed);
    const dispatcher = makeDispatcher(index.store);

    await resolve(dispatcher);
    indexed.add('Redis');
    dispatcher.invalidatePresentTechnologies();
    const after = await resolve(dispatcher);

    // The whole point of the fix is a FRESH answer, not a permissive one. Kafka was never
    // added, so it must still be reported absent -- otherwise the "fix" would just be
    // switching the fabrication check off.
    assert.equal(after.has('Kafka'), false, 'a technology that was never indexed must still be absent');
    assert.equal(after.has('Celery'), false, 'ditto -- invalidation must not mark everything present');
});

test('invalidation is safe to call repeatedly and before any resolution', () => {
    const index = stubIndex(new Set());
    const dispatcher = makeDispatcher(index.store);

    // extension.ts calls this from reloadPostIndexArtifacts(), which runs on the startup
    // rebuild too -- i.e. possibly before any question has been asked.
    dispatcher.invalidatePresentTechnologies();
    dispatcher.invalidatePresentTechnologies();
    assert.equal(index.searchCalls, 0, 'invalidation alone must not trigger a scan');
});
