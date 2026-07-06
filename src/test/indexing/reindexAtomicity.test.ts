import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LanceStore } from '../../store/lanceStore';
import { Bm25Store } from '../../store/bm25Store';
import { CodeChunk } from '../../store/storeTypes';

async function makeTempDir(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

function chunk(id: string, filePath: string, text: string): CodeChunk {
    return {
        id,
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 2,
        text,
        vector: new Array(768).fill(0.01),
        hash: id
    };
}

/**
 * These tests simulate a reindex being interrupted at the point production has
 * actually been found to fail (see PR): forceFullReindex() calls beginRebuild(),
 * fullIndex() throws or silently produces nothing, and either abortRebuild() runs
 * (a clean caught error) or nothing runs at all (the process is killed outright --
 * simulated here by simply never calling commit/abort and re-opening a fresh
 * instance from disk, since that's the only thing a real crash actually leaves
 * behind: whatever is on disk).
 */

test('LanceStore: process killed mid-rebuild (no abort, no commit) -- a fresh instance still sees the original chunks', async () => {
    const dir = await makeTempDir('lance-atomicity');
    const store = new LanceStore(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'original content one'), chunk('orig-2', 'b.ts', 'original content two')]);
    assert.equal(await store.getChunkCount(), 2);

    // Simulate the start of a reindex: stage a rebuild and insert nothing further --
    // exactly what "the process died before a single chunk embedded" looks like.
    await store.beginRebuild();
    // No commitRebuild(), no abortRebuild() -- simulating a hard crash/kill here.

    // A fresh instance (as a real restart, or any concurrent reader, would open)
    // must still see the untouched original data -- the pointer was never flipped.
    const reopened = new LanceStore(dir);
    await reopened.init();
    assert.equal(await reopened.getChunkCount(), 2);
    const paths = await reopened.getAllFilePaths();
    assert.deepEqual(new Set(paths), new Set(['a.ts', 'b.ts']));
});

test('LanceStore: commitRebuild() refuses to swap in an empty generation when previous data existed', async () => {
    const dir = await makeTempDir('lance-atomicity-refuse');
    const store = new LanceStore(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'original content')]);
    const previousCount = await store.getChunkCount();
    assert.equal(previousCount, 1);

    await store.beginRebuild();
    // Simulate "every embedding call failed" -- fullIndex() ran to completion but
    // produced zero chunks.
    const committed = await store.commitRebuild(previousCount);
    assert.equal(committed, false);

    assert.equal(await store.getChunkCount(), 1);
    const reopened = new LanceStore(dir);
    await reopened.init();
    assert.equal(await reopened.getChunkCount(), 1);
});

test('LanceStore: commitRebuild() swaps in real new data and the old generation is gone', async () => {
    const dir = await makeTempDir('lance-atomicity-success');
    const store = new LanceStore(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'stale content')]);
    const previousCount = await store.getChunkCount();

    await store.beginRebuild();
    await store.insertChunks([chunk('new-1', 'a.ts', 'fresh content'), chunk('new-2', 'c.ts', 'fresh content two')]);
    const committed = await store.commitRebuild(previousCount);
    assert.equal(committed, true);

    assert.equal(await store.getChunkCount(), 2);
    const reopened = new LanceStore(dir);
    await reopened.init();
    assert.equal(await reopened.getChunkCount(), 2);
    const paths = await reopened.getAllFilePaths();
    assert.deepEqual(new Set(paths), new Set(['a.ts', 'c.ts']));
});

test('LanceStore: abortRebuild() after a mid-rebuild error restores read/write access to the original generation', async () => {
    const dir = await makeTempDir('lance-atomicity-abort');
    const store = new LanceStore(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'original content')]);

    await store.beginRebuild();
    await store.insertChunks([chunk('partial-1', 'z.ts', 'half-written new content')]);
    // fullIndex() throws partway through -- forceFullReindex()'s catch block calls abortRebuild().
    await store.abortRebuild();

    assert.equal(await store.getChunkCount(), 1);
    const paths = await store.getAllFilePaths();
    assert.deepEqual(paths, ['a.ts']);
});

test('Bm25Store: process killed mid-rebuild (no abort, no commit) -- a fresh instance still sees the original documents', async () => {
    const dir = await makeTempDir('bm25-atomicity');
    const store = new Bm25Store(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'original searchable content'), chunk('orig-2', 'b.ts', 'more original content')]);
    assert.equal(await store.getChunkCount(), 2);

    await store.beginRebuild();
    // No commitRebuild(), no abortRebuild() -- simulating a hard crash/kill here.

    const reopened = new Bm25Store(dir);
    await reopened.init();
    assert.equal(await reopened.getChunkCount(), 2);
    const results = await reopened.search('original', 10);
    assert.equal(results.length, 2);
});

test('Bm25Store: commitRebuild() refuses to swap in an empty generation when previous data existed', async () => {
    const dir = await makeTempDir('bm25-atomicity-refuse');
    const store = new Bm25Store(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'original searchable content')]);
    const previousCount = await store.getChunkCount();

    await store.beginRebuild();
    const committed = await store.commitRebuild(previousCount);
    assert.equal(committed, false);

    assert.equal(await store.getChunkCount(), 1);
    const reopened = new Bm25Store(dir);
    await reopened.init();
    assert.equal(await reopened.getChunkCount(), 1);
});

test('Bm25Store: commitRebuild() swaps in real new data', async () => {
    const dir = await makeTempDir('bm25-atomicity-success');
    const store = new Bm25Store(dir);
    await store.init();
    await store.insertChunks([chunk('orig-1', 'a.ts', 'stale searchable content')]);
    const previousCount = await store.getChunkCount();

    await store.beginRebuild();
    await store.insertChunks([chunk('new-1', 'c.ts', 'fresh searchable content')]);
    const committed = await store.commitRebuild(previousCount);
    assert.equal(committed, true);

    assert.equal(await store.getChunkCount(), 1);
    const reopened = new Bm25Store(dir);
    await reopened.init();
    const results = await reopened.search('fresh', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].filePath, 'c.ts');
});
