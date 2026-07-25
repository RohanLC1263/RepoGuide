import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SegmentedMiniSearchIndex } from '../../store/segmentedMiniSearchIndex';

/**
 * A staged rebuild must never make the index look empty to a concurrent reader
 * holding the SAME instance.
 *
 * The extension's save-triggered refresh (2s debounce after any source save)
 * rebuilds the logical-unit BM25 index that the chat/retrieval pipeline is
 * simultaneously querying -- they share one store instance. Clearing in place made
 * that pipeline search an empty index for the whole repopulation window, surfacing
 * as "the code-search index appears corrupted (a referenced data fragment is
 * missing for the bm25 channel)" and as unexplained run-to-run evidence variance.
 */

interface Doc extends Record<string, unknown> {
    id: string;
    content: string;
}

function newIndex(dir: string): SegmentedMiniSearchIndex<Doc> {
    return new SegmentedMiniSearchIndex<Doc>(dir, 'test_idx', {
        fields: ['content'],
        storeFields: ['id', 'content'],
        idField: 'id'
    });
}

async function tmpDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'rg-segidx-'));
}

test('search() keeps returning the previous complete results while a rebuild is staged', async () => {
    const dir = await tmpDir();
    const index = newIndex(dir);
    await index.init();
    await index.addAllAsync([
        { id: 'a', content: 'alpha orchestrator' },
        { id: 'b', content: 'beta orchestrator' },
        { id: 'c', content: 'gamma orchestrator' }
    ]);
    assert.equal(index.search('orchestrator').length, 3, 'baseline');

    // Rebuild begins -- readers must NOT see an empty index from here on.
    await index.beginRebuild();
    assert.equal(index.search('orchestrator').length, 3, 'must still serve the previous index mid-rebuild');

    // Partially repopulated: readers still get the complete previous generation,
    // not the half-built staging one.
    await index.addAllAsync([{ id: 'a', content: 'alpha orchestrator' }]);
    assert.equal(index.search('orchestrator').length, 3, 'must not serve a half-populated staging generation');

    // Commit swaps atomically; now the new generation is served.
    const committed = await index.commitRebuild(3);
    assert.equal(committed, true);
    assert.equal(index.search('orchestrator').length, 1, 'after commit, the new generation is live');

    await fs.promises.rm(dir, { recursive: true, force: true });
});

test('abortRebuild() restores the previous index for readers', async () => {
    const dir = await tmpDir();
    const index = newIndex(dir);
    await index.init();
    await index.addAllAsync([
        { id: 'a', content: 'alpha orchestrator' },
        { id: 'b', content: 'beta orchestrator' }
    ]);

    await index.beginRebuild();
    await index.addAllAsync([{ id: 'z', content: 'zeta orchestrator' }]);
    await index.abortRebuild();

    const results = index.search('orchestrator');
    assert.equal(results.length, 2, 'aborting restores the pre-rebuild index');
    assert.deepEqual(results.map(r => r.id).sort(), ['a', 'b']);

    await fs.promises.rm(dir, { recursive: true, force: true });
});

test('commitRebuild() refuses to replace a non-empty index with an empty one', async () => {
    const dir = await tmpDir();
    const index = newIndex(dir);
    await index.init();
    await index.addAllAsync([{ id: 'a', content: 'alpha orchestrator' }]);

    await index.beginRebuild();
    // Nothing staged -- simulates a refresh that produced no units.
    const committed = await index.commitRebuild(1);
    assert.equal(committed, false, 'must not commit an empty rebuild over real data');
    assert.equal(index.search('orchestrator').length, 1, 'previous index stays live and queryable');

    await fs.promises.rm(dir, { recursive: true, force: true });
});
