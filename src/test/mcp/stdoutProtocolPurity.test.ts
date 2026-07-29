import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * mcpServer.ts speaks newline-delimited JSON-RPC over STDOUT. Anything that writes
 * to stdout from a module the MCP server loads is injected directly into the
 * protocol stream between real messages.
 *
 * This was live: a real five-tool-call session emitted 305 non-JSON stdout lines
 * against 6 JSON-RPC messages (288 of them one `[Deduplication Trace]` log). It went
 * unnoticed because the investigation's own client silently dropped unparseable
 * lines -- a standard-compliant client is under no obligation to be that forgiving.
 *
 * So this is a reachability test, not a style test: it walks the real relative-import
 * graph from mcpServer.ts and fails if any module on it can write to stdout.
 * Standalone CLI/audit scripts (src/registry/*, src/graph/audit_graph.ts) legitimately
 * print to stdout and are correctly excluded by being unreachable from this entry point.
 */

/** Walk up to the repo root, so this resolves the same whether it runs from src/ or out/. */
function repoRoot(): string {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const parent = path.dirname(dir);
        if (parent === dir) { throw new Error('repo root not found'); }
        dir = parent;
    }
    return dir;
}

const SRC = path.join(repoRoot(), 'src');
const ENTRY = path.join(SRC, 'mcp', 'mcpServer.ts');

/** Resolves a relative import specifier to a .ts file on disk, or null. */
function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) {
        return null; // node_modules / builtin -- not ours to police
    }
    const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''));
    for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function reachableModules(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    while (queue.length > 0) {
        const file = queue.pop() as string;
        if (seen.has(file)) { continue; }
        seen.add(file);
        const text = fs.readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        const re = new RegExp(IMPORT_RE.source, 'g');
        while ((m = re.exec(text)) !== null) {
            const resolved = resolveImport(file, m[1]);
            if (resolved && !seen.has(resolved)) { queue.push(resolved); }
        }
    }
    return seen;
}

/** Strips line and block comments so a commented-out example never fails the test. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('no module reachable from mcpServer.ts writes to stdout (JSON-RPC transport)', () => {
    const modules = reachableModules(ENTRY);
    assert.ok(modules.size > 50, `import walk looks broken -- only ${modules.size} modules reached`);

    const offenders: string[] = [];
    for (const file of modules) {
        const text = stripComments(fs.readFileSync(file, 'utf8'));
        if (/\bconsole\s*\.\s*log\s*\(/.test(text) || /\bprocess\s*\.\s*stdout\s*\.\s*write\s*\(/.test(text)) {
            offenders.push(path.relative(SRC, file).replace(/\\/g, '/'));
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'These modules are loaded by the MCP server and write to stdout, corrupting the ' +
        'JSON-RPC stream. Use console.error or the RepositoryContext logger instead:\n  ' +
        offenders.join('\n  ')
    );
});

test('the reachability walk really does reach the known query-path modules', () => {
    // Guards the guard: if the import walk silently stopped early, the test above
    // would pass vacuously.
    const modules = [...reachableModules(ENTRY)].map(f => path.relative(SRC, f).replace(/\\/g, '/'));
    for (const expected of [
        'prompts/evidencePrompt.ts',
        'query/evidencePacketBuilder.ts',
        'query/hybridRetrievalFusion.ts',
        'ollama/inferencer.ts',
        'query/queryDispatcher.ts'
    ]) {
        assert.ok(modules.includes(expected), `expected ${expected} to be reachable from mcpServer.ts`);
    }
});
