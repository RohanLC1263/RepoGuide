import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SegmentedMiniSearchIndex } from '../../store/segmentedMiniSearchIndex';

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
