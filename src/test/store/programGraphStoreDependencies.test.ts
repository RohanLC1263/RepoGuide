import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProgramGraphStore } from '../../store/programGraphStore';
import { ProgramGraph } from '../../graph/programGraphTypes';

/**
 * getDependencies() is the outbound mirror of getDependents() -- built to back
 * the new get_dependencies MCP tool ("what does this symbol itself call/read/
 * import/instantiate/fall back to," the reverse of "who depends on this").
 * These tests exercise the real ProgramGraphStore class against a real,
 * on-disk graph.json (written to a temp workspace and loaded via the store's
 * own public load()/buildIndexes() path -- no mocking of the store itself),
 * mirroring getDependents against getDependencies on the exact same edge set
 * to prove the two are genuine inverses of each other, not independently
 * re-implemented logic that happens to look similar.
 */

function buildGraph(): ProgramGraph {
    return {
        version: '1',
        builtAt: new Date().toISOString(),
        repoRoot: '/fake',
        nodeCount: 8,
        edgeCount: 7,
        nodes: {
            'file::src/a.ts': { id: 'file::src/a.ts', type: 'file', filePath: 'src/a.ts', role: 'implementation' },
            unitA: { id: 'unitA', type: 'function', symbol: 'doThing', filePath: 'src/a.ts', startLine: 10, endLine: 20, role: 'implementation' },
            unitB: { id: 'unitB', type: 'function', symbol: 'callee', filePath: 'src/b.ts', startLine: 1, endLine: 5, role: 'implementation' },
            unitC: { id: 'unitC', type: 'constant', symbol: 'CONFIG', filePath: 'src/c.ts', startLine: 1, endLine: 1, role: 'implementation' },
            unitD: { id: 'unitD', type: 'import', symbol: 'importedModule', filePath: 'src/d.ts', startLine: 1, endLine: 1, role: 'implementation' },
            unitE: { id: 'unitE', type: 'class', symbol: 'SomeClass', filePath: 'src/e.ts', startLine: 1, endLine: 30, role: 'implementation' },
            unitF: { id: 'unitF', type: 'function', symbol: 'fallbackFn', filePath: 'src/f.ts', startLine: 1, endLine: 5, role: 'implementation' },
            // Gives file::src/a.ts an INBOUND edge, same as a real indexed repo
            // where files are typically imported by something -- ProgramGraphStore's
            // file resolution (in both getDependents and getDependencies) looks up
            // the file node id via inEdges.keys(), so a file with zero inbound edges
            // of its own can't be resolved by path at all. Pre-existing behavior in
            // getDependents, mirrored as-is rather than worked around.
            unitG: { id: 'unitG', type: 'function', symbol: 'importsA', filePath: 'src/g.ts', startLine: 1, endLine: 3, role: 'implementation' }
        },
        edges: [
            { from: 'file::src/a.ts', to: 'unitA', type: 'contains', weight: 1 },
            { from: 'unitA', to: 'unitB', type: 'calls', weight: 0.9 },
            { from: 'unitA', to: 'unitC', type: 'reads', weight: 0.8 },
            { from: 'unitA', to: 'unitD', type: 'imports', weight: 0.7 },
            { from: 'unitA', to: 'unitE', type: 'instantiates', weight: 0.9 },
            { from: 'unitA', to: 'unitF', type: 'fallback_to', weight: 0.6 },
            { from: 'unitG', to: 'file::src/a.ts', type: 'imports', weight: 0.5 }
        ]
    };
}

function writeGraphToTempWorkspace(graph: ProgramGraph): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-graph-deps-test-'));
    const graphDir = path.join(workspaceRoot, '.repoguide', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify(graph), 'utf-8');
    return workspaceRoot;
}

test('getDependencies: a symbol with all five outbound edge types returns each in its own bucket, HIGH confidence', async () => {
    const workspaceRoot = writeGraphToTempWorkspace(buildGraph());
    try {
        const store = new ProgramGraphStore();
        await store.load(workspaceRoot);

        const result = store.getDependencies('doThing');
        assert.deepEqual(result.callees.map(n => n.id), ['unitB']);
        assert.deepEqual(result.readTargets.map(n => n.id), ['unitC']);
        assert.deepEqual(result.importTargets.map(n => n.id), ['unitD']);
        assert.deepEqual(result.instantiationTargets.map(n => n.id), ['unitE']);
        assert.deepEqual(result.fallbackTargets.map(n => n.id), ['unitF']);
        assert.equal(result.confidence, 'HIGH');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('getDependencies is the literal inverse of getDependents on the same edge set: A calls B <=> B is called by A', async () => {
    const workspaceRoot = writeGraphToTempWorkspace(buildGraph());
    try {
        const store = new ProgramGraphStore();
        await store.load(workspaceRoot);

        const dependencies = store.getDependencies('doThing');
        const dependents = store.getDependents('callee');

        assert.deepEqual(dependencies.callees.map(n => n.id), ['unitB']);
        assert.deepEqual(dependents.callers.map(n => n.id), ['unitA']);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('getDependencies resolves by file path too, pulling in the outbound edges of every unit the file contains (mirrors getDependents\' file resolution)', async () => {
    const workspaceRoot = writeGraphToTempWorkspace(buildGraph());
    try {
        const store = new ProgramGraphStore();
        await store.load(workspaceRoot);

        const bySymbol = store.getDependencies('doThing');
        const byFile = store.getDependencies('src/a.ts');
        assert.deepEqual(byFile.callees.map(n => n.id), bySymbol.callees.map(n => n.id));
        assert.deepEqual(byFile.readTargets.map(n => n.id), bySymbol.readTargets.map(n => n.id));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('getDependencies: only an import edge present -> MEDIUM confidence (mirrors getDependents\' same heuristic)', async () => {
    const graph = buildGraph();
    graph.edges = graph.edges.filter(edge => edge.type === 'contains' || edge.type === 'imports');
    const workspaceRoot = writeGraphToTempWorkspace(graph);
    try {
        const store = new ProgramGraphStore();
        await store.load(workspaceRoot);

        const result = store.getDependencies('doThing');
        assert.deepEqual(result.callees, []);
        assert.equal(result.importTargets.length, 1);
        assert.equal(result.confidence, 'MEDIUM');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('getDependencies: unknown symbol returns all-empty buckets with LOW confidence, does not throw', async () => {
    const workspaceRoot = writeGraphToTempWorkspace(buildGraph());
    try {
        const store = new ProgramGraphStore();
        await store.load(workspaceRoot);

        const result = store.getDependencies('thisSymbolDoesNotExist');
        assert.deepEqual(result.callees, []);
        assert.deepEqual(result.readTargets, []);
        assert.deepEqual(result.importTargets, []);
        assert.deepEqual(result.instantiationTargets, []);
        assert.deepEqual(result.fallbackTargets, []);
        assert.equal(result.confidence, 'LOW');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('getDependencies: no graph loaded at all returns all-empty buckets with LOW confidence, does not throw', () => {
    const store = new ProgramGraphStore();
    const result = store.getDependencies('anything');
    assert.deepEqual(result.callees, []);
    assert.equal(result.confidence, 'LOW');
});
