import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProgramGraphStore } from '../../store/programGraphStore';

/**
 * Persistence hardening for the program graph:
 *  - save() must be atomic (temp + rename), so a concurrent reader never observes a
 *    half-written graph.json.
 *  - load() must report a corrupt graph loudly instead of silently returning null,
 *    which previously made every dependency lookup answer "nothing depends on this"
 *    for the whole repository with no error anywhere.
 */

async function tmpRepo(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rg-graph-'));
    await fs.promises.mkdir(path.join(dir, '.repoguide', 'graph'), { recursive: true });
    return dir;
}

function graphPathOf(repoRoot: string): string {
    return path.join(repoRoot, '.repoguide', 'graph', 'graph.json');
}

const SAMPLE_GRAPH = {
    nodes: {
        'n1': { id: 'n1', symbol: 'Alpha', filePath: 'src/alpha.ts', type: 'class', role: 'implementation', startLine: 1, endLine: 5 },
        'n2': { id: 'n2', symbol: 'Beta', filePath: 'src/beta.ts', type: 'class', role: 'implementation', startLine: 1, endLine: 5 }
    },
    edges: [{ from: 'n2', to: 'n1', type: 'calls', weight: 1 }],
    nodeCount: 2,
    edgeCount: 1
};

test('save() round-trips through load() and leaves no temp files behind', async () => {
    const repo = await tmpRepo();
    const store = new ProgramGraphStore();
    (store as unknown as { graph: unknown }).graph = SAMPLE_GRAPH;
    await store.save(repo);

    const reader = new ProgramGraphStore();
    const loaded = await reader.load(repo);
    assert.ok(loaded, 'graph must load back');
    assert.equal(loaded!.nodeCount, 2);
    assert.equal(reader.getDependents('Alpha').callers.length, 1, 'indexes rebuilt on load');

    const leftovers = (await fs.promises.readdir(path.join(repo, '.repoguide', 'graph')))
        .filter(f => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0, `no temp files left behind, found: ${leftovers.join(', ')}`);

    await fs.promises.rm(repo, { recursive: true, force: true });
});

test('a corrupt graph.json is reported loudly, not swallowed silently', async () => {
    const repo = await tmpRepo();
    const store = new ProgramGraphStore();
    (store as unknown as { graph: unknown }).graph = SAMPLE_GRAPH;
    await store.save(repo);

    // Simulate an interrupted / truncated write.
    const real = await fs.promises.readFile(graphPathOf(repo), 'utf-8');
    await fs.promises.writeFile(graphPathOf(repo), real.slice(0, Math.floor(real.length * 0.6)), 'utf-8');

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
        const reader = new ProgramGraphStore();
        const loaded = await reader.load(repo);
        assert.equal(loaded, null, 'a corrupt graph still yields null');
        assert.equal(errors.length, 1, 'the failure must be reported, not swallowed');
        assert.match(errors[0], /could not be read/i);
        assert.match(errors[0], /Re-sync Index/i, 'message must tell the user how to recover');
    } finally {
        console.error = originalError;
    }

    await fs.promises.rm(repo, { recursive: true, force: true });
});

test('load() on a missing graph returns null without logging an error (not a failure case)', async () => {
    const repo = await tmpRepo();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
        const store = new ProgramGraphStore();
        assert.equal(await store.load(repo), null);
        assert.deepEqual(errors, [], 'a not-yet-built graph is normal, not an error');
    } finally {
        console.error = originalError;
    }
    await fs.promises.rm(repo, { recursive: true, force: true });
});
