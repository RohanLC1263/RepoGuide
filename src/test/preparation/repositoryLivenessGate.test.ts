import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepositoryLivenessGate } from '../../preparation/repositoryLivenessGate';
import { buildRepositoryReadinessReport } from '../../preparation/repositoryReadiness';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { LanceStore } from '../../store/lanceStore';
import { Bm25Store } from '../../store/bm25Store';
import { LogicalUnit } from '../../indexing/logicalUnitTypes';
import { CodeChunk } from '../../store/storeTypes';

async function makeTempRepo(prefix: string): Promise<{ workspaceRoot: string; repoguideDir: string }> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    await fs.mkdir(repoguideDir, { recursive: true });
    return { workspaceRoot, repoguideDir };
}

function chunk(id: string, filePath: string, text: string): CodeChunk {
    return {
        id, filePath, language: 'typescript', startLine: 1, endLine: 3, text,
        vector: new Array(768).fill(0.01), hash: id
    };
}

function unit(id: string): LogicalUnit {
    return {
        id,
        type: 'function',
        symbol: 'doSomething',
        filePath: 'src/a.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
        content: 'function doSomething() {}',
        role: 'implementation',
        parseStatus: 'complete',
        extractionMethod: 'tree_sitter',
        metadata: { confidence: 'high' }
    };
}

test('RepositoryLivenessGate reports never_indexed for a fresh repo with nothing built yet', async () => {
    const { workspaceRoot, repoguideDir } = await makeTempRepo('liveness-fresh');
    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);
    const result = await gate.check();
    assert.equal(result.status, 'never_indexed');
});

test('RepositoryLivenessGate reports corrupted when logical units exist but chunk stores are empty (the CraftConnect signature)', async () => {
    const { workspaceRoot, repoguideDir } = await makeTempRepo('liveness-corrupted');

    const unitStore = new LogicalUnitStore(repoguideDir);
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([unit('src/a.ts::doSomething::function::1')]);

    // Lance/BM25 are left untouched -- buildRepositoryReadinessReport() will find
    // them structurally present but empty, exactly like the real corruption found.
    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);
    const result = await gate.check();
    assert.equal(result.status, 'corrupted');
    assert.ok(result.message?.includes('interrupted'));
});

test('RepositoryLivenessGate reports ok when logical units and chunks are both populated', async () => {
    const { workspaceRoot, repoguideDir } = await makeTempRepo('liveness-ok');

    const unitStore = new LogicalUnitStore(repoguideDir);
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([unit('src/a.ts::doSomething::function::1')]);

    const lanceStore = new LanceStore(repoguideDir);
    await lanceStore.init();
    await lanceStore.insertChunks([{
        id: 'chunk-1', filePath: 'src/a.ts', language: 'typescript',
        startLine: 1, endLine: 3, text: 'function doSomething() {}',
        vector: new Array(768).fill(0.01), hash: 'chunk-1'
    }]);

    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);
    const result = await gate.check();
    assert.equal(result.status, 'ok');
});

test('RepositoryLivenessGate caches its result within the TTL and re-checks after invalidate()', async () => {
    const { workspaceRoot, repoguideDir } = await makeTempRepo('liveness-cache');
    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir, 60_000);

    const first = await gate.check();
    assert.equal(first.status, 'never_indexed');

    const unitStore = new LogicalUnitStore(repoguideDir);
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([unit('src/a.ts::doSomething::function::1')]);

    // Within the TTL, the cached (now-stale) result is still returned.
    const cached = await gate.check();
    assert.equal(cached.status, 'never_indexed');

    gate.invalidate();
    const fresh = await gate.check();
    assert.equal(fresh.status, 'corrupted');
});

test('buildRepositoryReadinessReport and RepositoryLivenessGate correctly report READY/ok when the active Lance/BM25 generation is 1 (post-rebuild-swap) -- the real CraftConnect regression', async () => {
    const { workspaceRoot, repoguideDir } = await makeTempRepo('liveness-gen1-swap');

    const unitStore = new LogicalUnitStore(repoguideDir);
    await unitStore.init(workspaceRoot);
    await unitStore.upsertUnits([unit('src/a.ts::doSomething::function::1')]);

    // Flip both Lance and BM25 to generation 1 via the real beginRebuild()/
    // commitRebuild() atomicity path (see reindexAtomicity.test.ts) -- this is
    // exactly what a normal, successful reindex does, not an artificial state.
    const lanceStore = new LanceStore(repoguideDir);
    await lanceStore.init();
    await lanceStore.insertChunks([chunk('orig-1', 'src/a.ts', 'stale content')]);
    const lancePrevCount = await lanceStore.getChunkCount();
    await lanceStore.beginRebuild();
    await lanceStore.insertChunks([chunk('new-1', 'src/a.ts', 'fresh content')]);
    assert.equal(await lanceStore.commitRebuild(lancePrevCount), true);

    const bm25Store = new Bm25Store(repoguideDir);
    await bm25Store.init();
    await bm25Store.insertChunks([chunk('orig-1', 'src/a.ts', 'stale searchable content')]);
    const bm25PrevCount = await bm25Store.getChunkCount();
    await bm25Store.beginRebuild();
    await bm25Store.insertChunks([chunk('new-1', 'src/a.ts', 'fresh searchable content')]);
    assert.equal(await bm25Store.commitRebuild(bm25PrevCount), true);

    // Sanity check that this test is really exercising generation 1, not
    // accidentally still sitting on generation 0.
    assert.equal(fsSync.existsSync(path.join(repoguideDir, 'chunks.lance')), false);
    assert.equal(fsSync.existsSync(path.join(repoguideDir, 'chunks_alt.lance')), true);
    assert.equal(fsSync.existsSync(path.join(repoguideDir, 'bm25_index_segments')), false);
    assert.equal(fsSync.existsSync(path.join(repoguideDir, 'bm25_index_segments_alt')), true);

    const report = await buildRepositoryReadinessReport(workspaceRoot, repoguideDir);
    const lanceArtifact = report.artifacts.find(a => a.name === 'lance_chunks');
    const bm25Artifact = report.artifacts.find(a => a.name === 'bm25');
    assert.equal(lanceArtifact?.status, 'READY');
    assert.equal(lanceArtifact?.recordCount, 1);
    assert.equal(bm25Artifact?.status, 'READY');
    assert.equal(bm25Artifact?.recordCount, 1);

    const gate = new RepositoryLivenessGate(workspaceRoot, repoguideDir);
    const result = await gate.check();
    assert.equal(result.status, 'ok');
});
