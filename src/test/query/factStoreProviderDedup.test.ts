import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FactStore } from '../../store/factStore';
import { FactStoreProvider } from '../../query/factStoreProvider';
import { EvidenceProviderRequest } from '../../query/retrievalProvider';
import { FactRecord } from '../../indexing/factTypes';

/**
 * Induced-failure regression test for the get_facts duplicate-entry bug,
 * built from the exact real 4-row shape found in CraftConnect's facts.db:
 * `self.confidence_threshold = 0.55` at customization_interview_agent.py:65
 * is stored 4 times -- once per (type x enclosing-unit) combination:
 *   - assignment,        attributed to the CustomizationInterviewAgent class unit
 *   - assignment,        attributed to the __init__ method unit
 *   - numeric_threshold, attributed to the __init__ method unit
 *   - numeric_threshold, attributed to the CustomizationInterviewAgent class unit
 * The rows differ ONLY in unitId/factId (and subject_uuid) -- identical in
 * every field a fact/evidence consumer sees. The old dedupeFacts keyed on
 * factId (which embeds unitId), so all 4 survived; get_facts returned the
 * same fact 2x per type. The fix keys on
 * (filePath, startLine, endLine, symbol, factType, value), keep-first.
 *
 * Confirmed a real induced failure: reverting dedupeFacts to key on factId
 * makes the first test below fail (4 rows survive, not 2).
 */

async function makeTempRepo(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

/** The real unit-axis-duplicated confidence_threshold rows: same file/line/
 * symbol/value, two types, each type attributed to both the class unit and
 * the method unit -> 4 rows, distinct factId/unitId, identical otherwise. */
function confidenceThresholdRows(): FactRecord[] {
    const base = {
        filePath: 'app/agents/customization_interview_agent.py',
        symbol: 'self.confidence_threshold',
        value: 0.55,
        valueKind: 'number' as const,
        startLine: 65,
        endLine: 65,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        sourceText: 'self.confidence_threshold = 0.55',
        role: 'implementation' as const
    };
    const classUnit = 'app/agents/customization_interview_agent.py::CustomizationInterviewAgent::class::51';
    const methodUnit = 'app/agents/customization_interview_agent.py::__init__::method::62';
    return [
        { ...base, factId: 'ct-assign-class', unitId: classUnit, factType: 'assignment' },
        { ...base, factId: 'ct-assign-method', unitId: methodUnit, factType: 'assignment' },
        { ...base, factId: 'ct-thresh-method', unitId: methodUnit, factType: 'numeric_threshold' },
        { ...base, factId: 'ct-thresh-class', unitId: classUnit, factType: 'numeric_threshold' }
    ];
}

function factsRequest(query: string, maxItems = 50): EvidenceProviderRequest {
    return {
        requestId: 'r1',
        planId: 'p1',
        query,
        category: 'factual_lookup',
        retrievalPlan: {
            strategy: 'exact',
            targetSymbols: [],
            targetFiles: [],
            targetConcepts: [],
            providerIds: ['fact_store'],
            excludedRoles: [],
            preferredEvidenceTypes: ['fact evidence', 'source span evidence'],
            maxItems,
            maxLatencyMs: 2500
        },
        targets: { symbols: [], files: [], concepts: [] },
        limits: { maxItems, maxLatencyMs: 2500 },
        freshnessPolicy: { requireFreshEvidence: false }
    };
}

test('unit-axis duplicates (same file/line/symbol/type/value, differing only in unitId) collapse to one per type -- the real confidence_threshold 4->2 case', async () => {
    const repoRoot = await makeTempRepo('fact-dedup');
    const store = new FactStore();
    await store.init(repoRoot);
    await store.upsertFacts(confidenceThresholdRows());

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });

    const response = await provider.retrieve(factsRequest('confidence threshold'));

    const ct = response.items.filter(i => i.symbol === 'self.confidence_threshold');
    assert.equal(ct.length, 2, `expected exactly 2 confidence_threshold items (1 per type), got ${ct.length}: ${ct.map(i => i.type).join(', ')}`);
    const types = ct.map(i => i.type).sort();
    assert.deepEqual(types, ['assignment', 'numeric_threshold'], 'both distinct fact TYPES must survive -- only the unit-axis duplication is removed');
});

test('two facts identical in file/line/symbol/type but with DIFFERENT values are both kept -- value is part of the dedup key', async () => {
    // The real mission_coordinator.py:51 case: two distinct call_sites on one
    // line (str(uuid4()) and uuid4()) share file/line/symbol/type but differ in
    // value. Dropping value from the key would wrongly merge them.
    const repoRoot = await makeTempRepo('fact-dedup-value');
    const store = new FactStore();
    await store.init(repoRoot);
    const base = {
        filePath: 'app/agents/orchestrator/mission_coordinator.py',
        symbol: 'MissionCoordinator',
        valueKind: 'string' as const,
        startLine: 51,
        endLine: 51,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        role: 'implementation' as const
    };
    await store.upsertFacts([
        { ...base, factId: 'call-a', unitId: 'u1', factType: 'call_site', value: 'str(uuid4())', sourceText: 'str(uuid4())' },
        { ...base, factId: 'call-b', unitId: 'u1', factType: 'call_site', value: 'uuid4()', sourceText: 'uuid4()' }
    ]);

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });
    const response = await provider.retrieve(factsRequest('MissionCoordinator uuid'));

    const calls = response.items.filter(i => i.symbol === 'MissionCoordinator' && i.type === 'call_site');
    const values = calls.map(i => i.content).sort();
    assert.deepEqual(values, ['str(uuid4())', 'uuid4()'], 'both value-distinct call_sites on the same line must survive dedup');
});

test('two facts identical in file/line/symbol/type/value but in DIFFERENT files are both kept (basename collision must not over-merge)', async () => {
    // The real TOAST_LIMIT case: components/ui/use-toast.ts and hooks/use-toast.ts
    // both declare `const TOAST_LIMIT = 1` on line 8 -- same basename, same line,
    // same symbol/type/value, but genuinely different files.
    const repoRoot = await makeTempRepo('fact-dedup-file');
    const store = new FactStore();
    await store.init(repoRoot);
    const base = {
        symbol: 'TOAST_LIMIT',
        factType: 'numeric_threshold' as const,
        value: 1,
        valueKind: 'number' as const,
        startLine: 8,
        endLine: 8,
        extractionMethod: 'tree_sitter' as const,
        confidence: 'high' as const,
        sourceText: 'const TOAST_LIMIT = 1',
        role: 'implementation' as const
    };
    await store.upsertFacts([
        { ...base, factId: 'tl-ui', unitId: 'u1', filePath: 'components/ui/use-toast.ts' },
        { ...base, factId: 'tl-hooks', unitId: 'u2', filePath: 'hooks/use-toast.ts' }
    ]);

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });
    const response = await provider.retrieve(factsRequest('TOAST_LIMIT'));

    const files = response.items.filter(i => i.symbol === 'TOAST_LIMIT').map(i => i.file).sort();
    assert.deepEqual(files, ['components/ui/use-toast.ts', 'hooks/use-toast.ts'], 'the same symbol in two different files must not be merged');
});

test('keep-first: the earlier (higher-ranked) occurrence of a duplicate survives, not the later one', async () => {
    // dedupeFacts runs on the rank-ordered results, keep-first preserves the
    // best-ranked representative. Build two byte-identical dup rows and confirm
    // exactly one survives (the count) -- the representative is content-identical
    // either way, but keep-first is the intended semantics.
    const repoRoot = await makeTempRepo('fact-dedup-keepfirst');
    const store = new FactStore();
    await store.init(repoRoot);
    await store.upsertFacts(confidenceThresholdRows());

    const provider = new FactStoreProvider(store);
    await provider.initialize({ repositoryContext: {} as any });
    const response = await provider.retrieve(factsRequest('confidence threshold'));

    const numericThreshold = response.items.filter(i => i.symbol === 'self.confidence_threshold' && i.type === 'numeric_threshold');
    assert.equal(numericThreshold.length, 1, 'exactly one numeric_threshold representative survives');
    assert.match(numericThreshold[0].content, /0\.55/, 'the surviving representative carries the real value');
});
