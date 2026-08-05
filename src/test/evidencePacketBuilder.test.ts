import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvidencePacketBuilder } from '../query/evidencePacketBuilder';
import { buildEvidencePlan } from '../query/evidencePlanner';

test('Evidence Packet Builder', async () => {
    // We mock the stores to return predictable data
    const mockUnitStore = {
        searchBySymbol: async (symbol: string) => {
            if (symbol === 'CONFIG_TIMEOUT') return [{ id: 'u1', role: 'implementation' }];
            if (symbol === 'DEFAULT_ITEMS') return [{ id: 'u2', role: 'implementation' }];
            if (symbol === 'fetchData') return [{ id: 'u3', role: 'implementation' }];
            if (symbol === 'Worker') return [{ id: 'u4', role: 'implementation' }];
            if (symbol === 'fakeHelper') return [{ id: 'u5', role: 'test' }];
            return [];
        },
        getUnit: async (id: string) => {
            if (id === 'u1') return { id: 'u1', type: 'constant_block', symbol: 'CONFIG_TIMEOUT', filePath: 'src/config.ts', language: 'typescript', startLine: 1, endLine: 1, content: 'const CONFIG_TIMEOUT = 5000;', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u2') return { id: 'u2', type: 'constant_block', symbol: 'DEFAULT_ITEMS', filePath: 'src/config.ts', language: 'typescript', startLine: 2, endLine: 2, content: 'const DEFAULT_ITEMS = [];', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u3') return { id: 'u3', type: 'function', symbol: 'fetchData', filePath: 'src/api.ts', language: 'typescript', startLine: 10, endLine: 20, content: 'function fetchData() {}', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u4') return { id: 'u4', type: 'class', symbol: 'Worker', filePath: 'src/worker.ts', language: 'typescript', startLine: 1, endLine: 10, content: 'class Worker {}', role: 'implementation', parseStatus: 'valid' };
            if (id === 'u5') return { id: 'u5', type: 'function', symbol: 'fakeHelper', filePath: 'src/test.ts', language: 'typescript', startLine: 1, endLine: 5, content: 'function fakeHelper() {}', role: 'test', parseStatus: 'valid' };
            return undefined;
        }
    } as any;

    const ALL_FACTS: any[] = [
        { factId: 'f1', filePath: 'src/config.ts', symbol: 'CONFIG_TIMEOUT', factType: 'numeric_threshold', value: 5000, confidence: 1.0, role: 'implementation' },
        { factId: 'f2', filePath: 'src/config.ts', symbol: 'DEFAULT_ITEMS', factType: 'list_count', value: 0, confidence: 1.0, role: 'implementation' },
        { factId: 'f3', filePath: 'src/api.ts', symbol: 'fetchData', factType: 'fallback_chain', value: 'a -> b', confidence: 0.9, role: 'implementation' },
        { factId: 'f4', filePath: 'src/worker.ts', symbol: 'Worker', factType: 'instantiation', value: 'new Worker()', confidence: 0.95, role: 'implementation' }
    ];

    const factsBySymbol = async (symbol: string, options: any = {}) => {
        if (options.excludeRoles && options.excludeRoles.includes('test') && symbol === 'fakeHelper') return [];
        return ALL_FACTS.filter(f => f.symbol === symbol);
    };

    // EvidencePacketBuilder moved to the batched findBySymbols/findByType API; this mock
    // still exposed only the original findBySymbol, so every test using it died with a
    // TypeError before reaching a single assertion. That read like a builder bug and was
    // a stale fixture. All three now derive from ALL_FACTS, so the fixture cannot drift
    // apart from itself again.
    const mockFactStore = {
        findBySymbol: factsBySymbol,
        findBySymbols: async (symbols: string[], options: any = {}) => {
            const out: any[] = [];
            for (const s of symbols) { out.push(...await factsBySymbol(s, options)); }
            return out;
        },
        findByType: async (factType: string) => ALL_FACTS.filter(f => f.factType === factType)
    } as any;

    const mockBm25Store = {
        search: async () => {
            return []; // Return empty for BM25 to focus on exact matches
        }
    } as any;

    const stores = {
        unitStore: mockUnitStore,
        factStore: mockFactStore,
        bm25Store: mockBm25Store
    };

    const builder = new EvidencePacketBuilder(stores, '/workspace');

    // 1. exact threshold query retrieves numeric fact and source unit
    const plan1 = buildEvidencePlan('What is the CONFIG_TIMEOUT limit?');
    const packet1 = await builder.buildPacket(plan1.originalQuery, plan1);
    assert.ok(packet1.facts.find(f => f.type === 'numeric_threshold' && f.symbol === 'CONFIG_TIMEOUT'));
    assert.ok(packet1.items.find(i => i.symbol === 'CONFIG_TIMEOUT' && i.type === 'constant_block'));

    // 2. list count query retrieves list_count and constant block
    const plan2 = buildEvidencePlan('How many items in DEFAULT_ITEMS?');
    const packet2 = await builder.buildPacket(plan2.originalQuery, plan2);
    assert.ok(packet2.facts.find(f => f.type === 'list_count' && f.symbol === 'DEFAULT_ITEMS'));

    // 3. fallback query retrieves full function and relevant branch/fallback facts
    const plan3 = buildEvidencePlan('What is the fallback failover for fetchData?');
    const packet3 = await builder.buildPacket(plan3.originalQuery, plan3);
    assert.ok(packet3.facts.find(f => f.type === 'fallback_chain'));
    assert.ok(packet3.items.find(i => i.type === 'function'));

    // 4. dependency injection query retrieves instantiation facts and source spans
    const plan4 = buildEvidencePlan('How is Worker injected and initialized?');
    const packet4 = await builder.buildPacket(plan4.originalQuery, plan4);
    assert.ok(packet4.facts.find(f => f.type === 'instantiation'));

    // 5. non-test query never returns test/generated evidence
    const plan5 = buildEvidencePlan('What is the value of fakeHelper?');
    const packet5 = await builder.buildPacket(plan5.originalQuery, plan5);
    // Even though fakeHelper matches, it is suppressed by the builder
    assert.equal(packet5.items.length, 0);
    assert.equal(packet5.facts.length, 0);

    // 6. A symbol that exists nowhere retrieves nothing and surfaces no structural gap.
    //
    // This assertion is INVERTED from what it originally claimed, on purpose. It used to
    // require `gaps` to contain 'structured gap: symbol not found'. buildPacket does still
    // compute that string -- but evidencePacketBuilder.ts (see the NOTE above the packet's
    // return) deliberately does NOT thread the Step 8/9 gaps/coverage into the returned
    // packet, surfacing only the truncation gap and provider-reported retrieval gaps.
    // That is documented, intentional behavior; the test was pinning a contract the code
    // had already left behind, and was only passing before because a stale factStore mock
    // made it throw a TypeError before it ever reached this line.
    //
    // Pinned as-is rather than "fixed" either way: resurrecting the structural gaps would
    // change gap semantics for every query type. The computed-then-discarded block is
    // recorded as a finding in ROADMAP.md ("CI runs the real suite (P0-4)"), not silently
    // accepted here.
    const plan6 = buildEvidencePlan('What is the limit for MISSING_SYMBOL?');
    const packet6 = await builder.buildPacket(plan6.originalQuery, plan6);
    assert.equal(packet6.items.length, 0, 'an unknown symbol must retrieve no source spans');
    assert.equal(packet6.facts.length, 0, 'an unknown symbol must retrieve no facts');
    assert.ok(
        !packet6.gaps.find(g => g.includes('structured gap: symbol not found')),
        'structural gaps are computed but intentionally not surfaced on the packet -- if this ' +
        'now fails, the NOTE in evidencePacketBuilder.ts was reverted and this test should ' +
        'go back to asserting the gap is present.'
    );

    // 7. packet order is deterministic across 3 runs
    const run1 = await builder.buildPacket(plan1.originalQuery, plan1);
    const run2 = await builder.buildPacket(plan1.originalQuery, plan1);
    const run3 = await builder.buildPacket(plan1.originalQuery, plan1);
    assert.deepEqual(run1.facts, run2.facts);
    assert.deepEqual(run2.facts, run3.facts);
});

test('Evidence Packet Builder normalizes absolute and relative file paths to the same form', async () => {
    // Simulates the real-world divergence found during CraftConnect dogfooding:
    // a symbol-index-derived unit reporting an absolute path, and a fact-store-derived
    // record for the same conceptual file reporting a workspace-relative one.
    const workspaceRoot = 'C:\\workspace';

    const mockUnitStore = {
        searchBySymbol: async (symbol: string) => {
            if (symbol === 'Widget') return [{ id: 'u1', role: 'implementation' }];
            return [];
        },
        getUnit: async (id: string) => {
            if (id === 'u1') {
                return {
                    id: 'u1',
                    type: 'class',
                    symbol: 'Widget',
                    filePath: 'C:\\workspace\\src\\widget.ts', // absolute, backslashed -- as SymbolIndex-derived items do
                    language: 'typescript',
                    startLine: 1,
                    endLine: 5,
                    content: 'class Widget {}',
                    role: 'implementation',
                    parseStatus: 'valid'
                };
            }
            return undefined;
        }
    } as any;

    const WIDGET_FACTS: any[] = [{
        factId: 'f1',
        filePath: 'src/widget.ts', // workspace-relative -- as FactStore-derived records do
        symbol: 'Widget',
        factType: 'instantiation',
        value: 'new Widget()',
        confidence: 0.9,
        role: 'implementation'
    }];

    // Same stale-mock fix as above: the builder calls findBySymbols/findByType now.
    const mockFactStore = {
        findBySymbol: async (symbol: string) => WIDGET_FACTS.filter(f => f.symbol === symbol),
        findBySymbols: async (symbols: string[]) => WIDGET_FACTS.filter(f => symbols.includes(f.symbol)),
        findByType: async (factType: string) => WIDGET_FACTS.filter(f => f.factType === factType)
    } as any;

    const mockBm25Store = { search: async () => [] } as any;

    const builder = new EvidencePacketBuilder({
        unitStore: mockUnitStore,
        factStore: mockFactStore,
        bm25Store: mockBm25Store
    }, workspaceRoot);

    const plan = buildEvidencePlan('How is Widget injected and initialized?');
    const packet = await builder.buildPacket(plan.originalQuery, plan);

    const unitItem = packet.items.find(i => i.symbol === 'Widget');
    const fact = packet.facts.find(f => f.symbol === 'Widget');
    assert.ok(unitItem, 'expected a Widget evidence item from the unit store');
    assert.ok(fact, 'expected a Widget fact from the fact store');

    // Both should now report the identical, workspace-relative, forward-slashed form --
    // proving the same real file no longer produces two distinct citedFiles strings.
    assert.equal(unitItem!.file, 'src/widget.ts');
    assert.equal(fact!.file, 'src/widget.ts');
});

test('Evidence Packet Builder normalizes retrievalResult-sourced items too (RetrievalOrchestrator bypass)', async () => {
    // RetrievalOrchestrator-sourced items (symbol_index/hybrid_retrieval/program_graph
    // providers) arrive as already-built EvidenceItems via buildPacket()'s optional
    // retrievalResult param -- a separate code path from unitToItem/factToItem that
    // was missed in the first pass of this fix and still produced absolute-path dupes.
    const workspaceRoot = 'C:\\workspace';

    const mockUnitStore = { searchBySymbol: async () => [], getUnit: async () => undefined } as any;
    const mockFactStore = { findBySymbol: async () => [] } as any;
    const mockBm25Store = { search: async () => [] } as any;

    const builder = new EvidencePacketBuilder({
        unitStore: mockUnitStore,
        factStore: mockFactStore,
        bm25Store: mockBm25Store
    }, workspaceRoot);

    const plan = buildEvidencePlan('How is Gadget used?');
    const retrievalResult = {
        planId: 'p1',
        items: [{
            id: 'ret1',
            file: 'C:\\workspace\\src\\gadget.ts', // absolute, backslashed -- as symbol_index-sourced items do
            startLine: 1,
            endLine: 5,
            role: 'implementation',
            symbol: 'Gadget',
            type: 'class',
            content: 'class Gadget {}',
            retrieval_signal: 'symbol_index',
            score: 1,
            confidence: 0.9,
            extractionMethod: 'symbol_index'
        }],
        providerResults: [],
        gaps: [],
        coverage: { requiredTypes: [], coveredTypes: [], missingTypes: [] },
        diagnostics: [],
        metadata: { latencyMs: 0, providersInvoked: [], providersSkipped: [], providersFailed: [] }
    } as any;

    const packet = await builder.buildPacket(plan.originalQuery, plan, retrievalResult);
    const item = packet.items.find(i => i.symbol === 'Gadget');
    assert.ok(item, 'expected the retrievalResult-sourced Gadget item to be present');
    assert.equal(item!.file, 'src/gadget.ts');
});

test('checkStale resolves file paths against workspaceRoot, not process.cwd() (regression: everything-stale bug)', async () => {
    // Reproduces the real bug found via CraftConnect/axios investigation: checkStale()
    // resolved the evidence item's file path against process.cwd() instead of
    // this.workspaceRoot. Since a test process's cwd (the repo root running `node --test`)
    // is never the same directory as a real workspace being queried, the stat call threw
    // ENOENT for every item, and the catch block fails open to "stale" -- so every fresh
    // file in every real query got wrongly flagged [STALE]. Using a genuinely distinct
    // temp workspaceRoot here (never equal to process.cwd()) means this test fails against
    // the pre-fix code and passes against the fix.
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-stale-test-'));
    try {
        const relFile = 'src/foo.ts';
        const absFile = path.join(workspaceRoot, relFile);
        fs.mkdirSync(path.dirname(absFile), { recursive: true });
        fs.writeFileSync(absFile, 'export const FooSymbol = 1;\n');
        const stat = fs.statSync(absFile);

        const mockUnitStore = {
            searchBySymbol: async (symbol: string) => {
                if (symbol === 'FooSymbol') return [{ id: 'u1', role: 'implementation' }];
                return [];
            },
            getUnit: async (id: string) => {
                if (id === 'u1') {
                    return {
                        id: 'u1', type: 'constant_block', symbol: 'FooSymbol', filePath: relFile,
                        language: 'typescript', startLine: 1, endLine: 1, content: 'export const FooSymbol = 1;',
                        role: 'implementation', parseStatus: 'valid'
                    };
                }
                return undefined;
            }
        } as any;
        // Deliberately empty: these checkStale tests exercise unit/manifest paths, not
        // facts. All three methods still have to EXIST or the builder throws a TypeError.
        const mockFactStore = { findBySymbol: async () => [], findBySymbols: async () => [], findByType: async () => [] } as any;
        const mockBm25Store = { search: async () => [] } as any;
        const mockManifestStore = {
            getEntry: (relPath: string) => {
                if (relPath === relFile) {
                    return { relativePath: relFile, size: stat.size, mtimeMs: stat.mtimeMs, contentHash: '', indexedAt: '', language: 'typescript', role: 'implementation', unitCount: 1, factCount: 0, parseDiagnostics: [] };
                }
                return undefined;
            }
        } as any;

        const builder = new EvidencePacketBuilder({
            unitStore: mockUnitStore,
            factStore: mockFactStore,
            bm25Store: mockBm25Store,
            manifestStore: mockManifestStore
        }, workspaceRoot);

        const plan = buildEvidencePlan('What is the value of FooSymbol?');
        const packet = await builder.buildPacket(plan.originalQuery, plan);
        const item = packet.items.find(i => i.symbol === 'FooSymbol');

        assert.ok(item, 'expected a FooSymbol evidence item');
        assert.ok(!item!.stale, 'a genuinely fresh file (real mtime/size matches the manifest) must not be flagged stale');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('checkStale still flags a genuine mtime/size mismatch as stale post-fix', async () => {
    // Control for the fix above: confirms the path-resolution fix didn't accidentally
    // suppress real staleness detection -- a manifest entry that genuinely disagrees with
    // the file on disk must still produce stale: true.
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-stale-test-'));
    try {
        const relFile = 'src/bar.ts';
        const absFile = path.join(workspaceRoot, relFile);
        fs.mkdirSync(path.dirname(absFile), { recursive: true });
        fs.writeFileSync(absFile, 'export const BarSymbol = 2;\n');
        const stat = fs.statSync(absFile);

        const mockUnitStore = {
            searchBySymbol: async (symbol: string) => {
                if (symbol === 'BarSymbol') return [{ id: 'u1', role: 'implementation' }];
                return [];
            },
            getUnit: async (id: string) => {
                if (id === 'u1') {
                    return {
                        id: 'u1', type: 'constant_block', symbol: 'BarSymbol', filePath: relFile,
                        language: 'typescript', startLine: 1, endLine: 1, content: 'export const BarSymbol = 2;',
                        role: 'implementation', parseStatus: 'valid'
                    };
                }
                return undefined;
            }
        } as any;
        // Deliberately empty: these checkStale tests exercise unit/manifest paths, not
        // facts. All three methods still have to EXIST or the builder throws a TypeError.
        const mockFactStore = { findBySymbol: async () => [], findBySymbols: async () => [], findByType: async () => [] } as any;
        const mockBm25Store = { search: async () => [] } as any;
        const mockManifestStore = {
            getEntry: (relPath: string) => {
                if (relPath === relFile) {
                    // Deliberately stale: manifest recorded a different size than what's on disk now,
                    // simulating a file edited after indexing.
                    return { relativePath: relFile, size: stat.size + 1, mtimeMs: stat.mtimeMs, contentHash: '', indexedAt: '', language: 'typescript', role: 'implementation', unitCount: 1, factCount: 0, parseDiagnostics: [] };
                }
                return undefined;
            }
        } as any;

        const builder = new EvidencePacketBuilder({
            unitStore: mockUnitStore,
            factStore: mockFactStore,
            bm25Store: mockBm25Store,
            manifestStore: mockManifestStore
        }, workspaceRoot);

        const plan = buildEvidencePlan('What is the value of BarSymbol?');
        const packet = await builder.buildPacket(plan.originalQuery, plan);
        const item = packet.items.find(i => i.symbol === 'BarSymbol');

        assert.ok(item, 'expected a BarSymbol evidence item');
        assert.equal(item!.stale, true, 'a real size mismatch against the manifest must still be flagged stale');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});
