import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FactStore } from '../store/factStore';
import { FactRecord } from '../indexing/factTypes';

async function makeTempRepo(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test('FactStore preserves the real casing of a mixed-case filePath in the stored value (case-mismatch regression)', async () => {
    // Reproduces the confirmed bug (see docs/engineering-log/HALLUCINATION_INVESTIGATION_REPORT.md /
    // CHANGELOG.md "Fixed"): filePath was being lowercased at write time, silently
    // diverging the stored value from the real path for any file whose real path
    // contains uppercase letters -- corrupting citations on case-sensitive filesystems.
    const repoRoot = await makeTempRepo('fact-store-casing');
    const store = new FactStore();
    await store.init(repoRoot);

    const fact: FactRecord = {
        factId: 'fact-1',
        filePath: 'src/MyComponent.tsx',
        unitId: 'src/MyComponent.tsx::Widget::class::1',
        symbol: 'Widget',
        factType: 'constant',
        value: '42',
        valueKind: 'string',
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'const X = 42;',
        role: 'implementation'
    };
    await store.upsertFacts([fact]);

    // Query by the real, mixed-case path -- the stored value must retain that casing,
    // not fold to "src/mycomponent.tsx".
    const byRealCase = await store.queryFacts({ filePath: 'src/MyComponent.tsx' });
    assert.equal(byRealCase.length, 1);
    assert.equal(byRealCase[0].filePath, 'src/MyComponent.tsx');

    // Lookup must still work case-insensitively even though the stored value isn't folded.
    const byLowerCase = await store.queryFacts({ filePath: 'src/mycomponent.tsx' });
    assert.equal(byLowerCase.length, 1);
    assert.equal(byLowerCase[0].filePath, 'src/MyComponent.tsx');
});

test('FactStore deleteFile removes facts for a file regardless of query casing', async () => {
    const repoRoot = await makeTempRepo('fact-store-delete-casing');
    const store = new FactStore();
    await store.init(repoRoot);

    const fact: FactRecord = {
        factId: 'fact-2',
        filePath: 'src/Widget.tsx',
        unitId: 'src/Widget.tsx::Widget::class::1',
        symbol: 'Widget',
        factType: 'constant',
        value: '1',
        valueKind: 'string',
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'const X = 1;',
        role: 'implementation'
    };
    await store.upsertFacts([fact]);
    assert.equal((await store.queryFacts({ filePath: 'src/Widget.tsx' })).length, 1);

    await store.deleteFile('src/widget.tsx');
    assert.equal((await store.queryFacts({ filePath: 'src/Widget.tsx' })).length, 0);
});

test('findBySymbol matches a stored dotted/qualified symbol by its bare suffix -- reproduces the live CraftConnect bug (querying "confidence_threshold" found nothing because the extractor stored "self.confidence_threshold")', async () => {
    const repoRoot = await makeTempRepo('fact-store-symbol-suffix');
    const store = new FactStore();
    await store.init(repoRoot);

    const fact: FactRecord = {
        factId: 'fact-3',
        filePath: 'app/agents/customization_interview_agent.py',
        unitId: 'app/agents/customization_interview_agent.py::CustomizationInterviewAgent::class::1',
        symbol: 'self.confidence_threshold',
        factType: 'numeric_threshold',
        value: 0.55,
        valueKind: 'number',
        startLine: 65,
        endLine: 65,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'self.confidence_threshold = 0.55',
        role: 'implementation'
    };
    await store.upsertFacts([fact]);

    const bySuffix = await store.findBySymbol('confidence_threshold');
    assert.equal(bySuffix.length, 1, 'a bare-name query must match a symbol stored with a qualifying prefix');
    assert.equal(bySuffix[0].factId, 'fact-3');

    const byExact = await store.findBySymbol('self.confidence_threshold');
    assert.equal(byExact.length, 1, 'exact match must still work, unaffected by the suffix addition');
});

test('findBySymbol suffix matching does not false-positive on an unrelated symbol that merely ends with similar characters', async () => {
    const repoRoot = await makeTempRepo('fact-store-symbol-suffix-negative');
    const store = new FactStore();
    await store.init(repoRoot);

    const fact: FactRecord = {
        factId: 'fact-4',
        filePath: 'src/other.ts',
        unitId: 'src/other.ts::unrelated::const::1',
        symbol: 'someOtherThreshold',
        factType: 'constant',
        value: '1',
        valueKind: 'number',
        startLine: 1,
        endLine: 1,
        extractionMethod: 'ast_query',
        confidence: 'high',
        sourceText: 'const someOtherThreshold = 1;',
        role: 'implementation'
    };
    await store.upsertFacts([fact]);

    // "someOtherThreshold" does not end with ".confidence_threshold" -- must not match.
    const results = await store.findBySymbol('confidence_threshold');
    assert.equal(results.length, 0);
});
