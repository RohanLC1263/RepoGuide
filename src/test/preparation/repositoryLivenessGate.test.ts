import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepositoryLivenessGate } from '../../preparation/repositoryLivenessGate';
import { LogicalUnitStore } from '../../store/logicalUnitStore';
import { LanceStore } from '../../store/lanceStore';
import { LogicalUnit } from '../../indexing/logicalUnitTypes';

async function makeTempRepo(prefix: string): Promise<{ workspaceRoot: string; repoguideDir: string }> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    await fs.mkdir(repoguideDir, { recursive: true });
    return { workspaceRoot, repoguideDir };
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
