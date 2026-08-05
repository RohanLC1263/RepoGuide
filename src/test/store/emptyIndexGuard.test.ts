import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SegmentedMiniSearchIndex } from '../../store/segmentedMiniSearchIndex';
import { LogicalUnitBm25Store } from '../../store/logicalUnitBm25Store';
import { LogicalUnit } from '../../indexing/logicalUnitTypes';

/**
 * The first-run false-success bug (ROADMAP ~line 465).
 *
 * The empty-index guard was RELATIVE: `previousDocCount > 0 && newDocCount === 0`. On a first
 * run there is nothing to compare against, so `previousDocCount` is 0 by definition and the
 * guard was structurally unable to fire -- exactly when a false success is most damaging. A
 * workspace whose embeddings were unreachable committed a zero-chunk index and reported
 * success, and nothing downstream could tell that apart from a genuinely empty repository.
 *
 * `expectedNonEmpty` makes the guard absolute: the caller reports whether the walk found real
 * files, so "files present, zero chunks produced" is refused as the pipeline failure it is.
 */

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rg-empty-guard-'));
}

interface Doc extends Record<string, unknown> { id: string; content: string }

async function freshIndex(): Promise<SegmentedMiniSearchIndex<Doc>> {
    const idx = new SegmentedMiniSearchIndex<Doc>(tmpDir(), 'test_index', {
        fields: ['content'],
        storeFields: ['id', 'content'],
        idField: 'id'
    });
    await idx.init();
    return idx;
}

test('FIRST RUN: zero docs from a repo that HAD files is refused (the regression)', async () => {
    const idx = await freshIndex();
    await idx.beginRebuild();
    // fullIndex walked files but produced nothing -- embeddings unreachable.
    const committed = await idx.commitRebuild(0, true);
    assert.equal(committed, false, 'must NOT commit an empty index when files were present');
});

test('FIRST RUN: zero docs from a genuinely empty repo still commits', async () => {
    const idx = await freshIndex();
    await idx.beginRebuild();
    const committed = await idx.commitRebuild(0, false);
    assert.equal(committed, true, 'an empty repository is a legitimate empty index');
});

test('the old relative guard still holds: zero docs after having docs is refused', async () => {
    const idx = await freshIndex();
    await idx.beginRebuild();
    const committed = await idx.commitRebuild(5, false);
    assert.equal(committed, false);
});

test('a rebuild that produced real docs commits regardless of the flag', async () => {
    for (const expectedNonEmpty of [true, false]) {
        const idx = await freshIndex();
        await idx.beginRebuild();
        await idx.addAllAsync([{ id: 'u1', content: 'def foo(): pass' }]);
        const committed = await idx.commitRebuild(0, expectedNonEmpty);
        assert.equal(committed, true, `should commit real content (expectedNonEmpty=${expectedNonEmpty})`);
    }
});

test('default is backward compatible: omitting the flag preserves the old relative behaviour', async () => {
    const idx = await freshIndex();
    await idx.beginRebuild();
    const committed = await idx.commitRebuild(0);
    assert.equal(committed, true, 'no flag + no previous docs = old behaviour (commit)');
});

// --- LogicalUnitBm25Store: the store the QUERY PIPELINE actually reads ------------
//
// The guard above was already correct in SegmentedMiniSearchIndex, and
// LogicalUnitBm25Store forwarded both parameters to it correctly. Neither was the bug.
// The bug was at the CALL SITES, and this store had the weakest protection of the four
// despite being the one QueryDispatcher searches (wired as its bm25Store, extension.ts):
//
//   - full reindex: no generation swap AT ALL. `clearAll()` ran unconditionally before
//     fullIndex() had done anything, so a reindex that then produced nothing left this
//     store empty with no rollback, while Lance and chunk-BM25 rolled back cleanly.
//     Reproduced live 2026-08-05 against a real two-file repo: 5 chunks indexed, logical-unit
//     BM25 count 0, and real symbols present in the source (`applyLoyaltyDiscount`,
//     `compute_retail_price`, `OrderValidator`) each returned 0 search results.
//   - incremental refresh: had the swap, but never passed `expectedNonEmpty`, so it only
//     ever had the RELATIVE guard and could not fire on a first population -- which is
//     precisely the state a full reindex left behind.
//
// These exercise the store directly, which no test previously did.

function unit(id: string, symbol: string): LogicalUnit {
    return {
        id, symbol, filePath: 'src/orders.ts', content: `function ${symbol}() {}`,
        role: 'source', type: 'function', startLine: 1, endLine: 3,
        language: 'typescript', parseStatus: 'ok', extractionMethod: 'tree_sitter'
    } as unknown as LogicalUnit;
}

async function freshLuStore(): Promise<LogicalUnitBm25Store> {
    const store = new LogicalUnitBm25Store(tmpDir());
    await store.init();
    return store;
}

test('LogicalUnitBm25Store FIRST RUN: zero units when source files WERE parsed is refused', async () => {
    // The reproduced failure: extraction yields nothing while chunking succeeds. Before the
    // fix this path had no commitRebuild at all, so nothing could refuse it.
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([]);
    const committed = await store.commitRebuild(0, true);
    assert.equal(committed, false, 'must NOT commit an empty logical-unit index when real source was parsed');
});

test('LogicalUnitBm25Store FIRST RUN: zero units from a repo with no parseable source still commits', async () => {
    // A docs-only repository legitimately produces zero logical units. This is why the
    // full-reindex signal is parseable-source-file count, not lastWalkedFileCount.
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([]);
    assert.equal(await store.commitRebuild(0, false), true, 'a repo with no parseable source is legitimately unit-less');
});

test('LogicalUnitBm25Store: the relative guard still holds -- units, then zero, is refused', async () => {
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([unit('u1', 'applyLoyaltyDiscount')]);
    assert.equal(await store.commitRebuild(0, true), true);
    const previous = store.getIndexedCount();
    assert.ok(previous > 0, 'precondition: the store holds units');

    await store.beginRebuild();
    await store.indexUnits([]);
    assert.equal(await store.commitRebuild(previous), false, 'must not replace a populated index with an empty one');
});

test('LogicalUnitBm25Store: a rebuild that produced real units commits and is searchable', async () => {
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([unit('u1', 'applyLoyaltyDiscount'), unit('u2', 'compute_retail_price')]);
    assert.equal(await store.commitRebuild(0, true), true);
    assert.equal(store.getIndexedCount(), 2);
    // The point of the store: the query pipeline can find the symbol afterwards.
    const hits = await store.search('applyLoyaltyDiscount', 5);
    assert.ok(hits.length > 0, 'a committed index must actually be searchable');
});

test('LogicalUnitBm25Store: omitting the flag preserves the old relative behaviour', async () => {
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([]);
    assert.equal(await store.commitRebuild(0), true, 'no previous units and no flag -- backward compatible');
});

test('LogicalUnitBm25Store: a refused commit leaves the PREVIOUS units queryable, not an empty index', async () => {
    // The user-visible property that matters: refusing to commit must not also destroy what
    // was there. This is what the full-reindex path could not offer at all before.
    const store = await freshLuStore();
    await store.beginRebuild();
    await store.indexUnits([unit('u1', 'OrderValidator')]);
    await store.commitRebuild(0, true);

    await store.beginRebuild();
    await store.indexUnits([]);
    await store.commitRebuild(store.getIndexedCount(), true);

    assert.ok(store.getIndexedCount() > 0, 'previous units must survive a refused commit');
    assert.ok((await store.search('OrderValidator', 5)).length > 0, 'and must still be searchable');
});
