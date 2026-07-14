import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildEntry,
    exportQueryEvidence,
    readQueryEvidence,
    capReferencesByKind,
    QUERY_EVIDENCE_SCHEMA,
    QUERY_EVIDENCE_MAX_ENTRIES,
    QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND,
    QUERY_EVIDENCE_FILENAME,
    QueryEvidenceReference
} from '../../query/queryEvidenceExporter';
import { EvidenceItem, EvidencePacket } from '../../query/evidencePacket';
import { EvidencePlan } from '../../query/evidencePlanTypes';
import { GateResult } from '../../query/answerGate';

// Design: exports references (file/line/symbol), never evidence content --
// index-time chunk text can lag the real file, so exporting it would invite
// a connected agent to generate from stale text. This is also why there is
// no redaction concern here: there is no content field for a redacted value
// to leak through.

function makeItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
    return {
        id: 'item_1',
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        role: 'implementation',
        type: 'function',
        content: 'placeholder content -- never exported, see buildEntry\'s doc comment',
        retrieval_signal: 'bm25',
        score: 0.8,
        confidence: 0.8,
        extractionMethod: 'test',
        ...overrides
    };
}

function makePlan(overrides: Partial<EvidencePlan> = {}): EvidencePlan {
    return {
        originalQuery: 'q',
        normalizedQuery: 'q',
        queryType: 'behavior_explanation',
        requiredEvidence: [],
        symbolHints: [],
        fileHints: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'both',
        retrievalStrategy: 'exact_match',
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode: 'exact',
        ...overrides
    };
}

function makePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
    return {
        query: 'q',
        plan: makePlan(),
        items: [],
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: 0.5,
        matchedEvidenceTypes: [],
        ...overrides
    };
}

function makeGateResult(overrides: Partial<GateResult> = {}): GateResult {
    return {
        outcome: 'pass',
        supported_claims: [],
        unsupported_claims: [],
        removed_or_rewritten_claims: [],
        required_gaps: [],
        finalAnswer: 'answer',
        diagnostics: [],
        ...overrides
    };
}

// --- buildEntry ---

test('buildEntry produces the full repoguide.query_evidence.v1 shape', () => {
    const now = new Date('2026-07-12T10:00:00.000Z');
    const entry = buildEntry(
        'How does settle() decide to resolve vs reject?',
        'It resolves when the status is missing or validateStatus passes.',
        makePacket({ coverageScore: 0.75, plan: makePlan({ confidence_mode: 'grounded' }) }),
        makeGateResult({ outcome: 'revise' }),
        'vscode',
        false,
        now
    );

    assert.equal(entry.schema, QUERY_EVIDENCE_SCHEMA);
    assert.equal(entry.question, 'How does settle() decide to resolve vs reject?');
    assert.equal(entry.answer, 'It resolves when the status is missing or validateStatus passes.');
    assert.equal(entry.answeredAt, now.toISOString());
    assert.equal(entry.client, 'vscode');
    assert.equal(entry.decomposed, false);
    assert.deepEqual(entry.gateStatus, { outcome: 'revise', mode: 'grounded' });
    assert.equal(entry.coverageScore, 0.75);
    assert.deepEqual(entry.references, []);
});

test('references are built from both items and facts, tagged with the right kind', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({
            items: [makeItem({ id: 'i1', file: 'src/a.ts', startLine: 1, endLine: 5, symbol: 'doThing', type: 'function' })],
            facts: [makeItem({ id: 'f1', file: 'src/b.ts', startLine: 10, endLine: 10, symbol: 'THRESHOLD', type: 'numeric_threshold' })]
        }),
        makeGateResult(),
        'mcp',
        false
    );

    assert.equal(entry.references.length, 2);
    assert.deepEqual(entry.references[0], { file: 'src/a.ts', startLine: 1, endLine: 5, symbol: 'doThing', type: 'function', kind: 'item' });
    assert.deepEqual(entry.references[1], { file: 'src/b.ts', startLine: 10, endLine: 10, symbol: 'THRESHOLD', type: 'numeric_threshold', kind: 'fact' });
});

test('references are deduped by file:startLine:endLine -- an item and a fact at the exact same span collapse to one entry', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({
            items: [makeItem({ id: 'i1', file: 'src/a.ts', startLine: 1, endLine: 5, symbol: 'itemVersion' })],
            facts: [makeItem({ id: 'f1', file: 'src/a.ts', startLine: 1, endLine: 5, symbol: 'factVersion' })]
        }),
        makeGateResult(),
        'vscode',
        false
    );

    assert.equal(entry.references.length, 1);
    // Items are processed first, so the item's copy of this span wins.
    assert.equal(entry.references[0].kind, 'item');
    assert.equal(entry.references[0].symbol, 'itemVersion');
});

test('two genuinely different spans in the same file are NOT deduped', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({
            items: [
                makeItem({ id: 'i1', file: 'src/a.ts', startLine: 1, endLine: 5 }),
                makeItem({ id: 'i2', file: 'src/a.ts', startLine: 10, endLine: 15 })
            ]
        }),
        makeGateResult(),
        'vscode',
        false
    );
    assert.equal(entry.references.length, 2);
});

test('decomposed flag is recorded as given, independent of anything in the packet/gateResult', () => {
    const decomposedEntry = buildEntry('q', 'a', makePacket(), makeGateResult(), 'vscode', true);
    const singleShotEntry = buildEntry('q', 'a', makePacket(), makeGateResult(), 'vscode', false);
    assert.equal(decomposedEntry.decomposed, true);
    assert.equal(singleShotEntry.decomposed, false);
});

test('client field distinguishes a chat (vscode) answer from an MCP ask_repoguide answer', () => {
    const vscodeEntry = buildEntry('q', 'a', makePacket(), makeGateResult(), 'vscode', false);
    const mcpEntry = buildEntry('q', 'a', makePacket(), makeGateResult(), 'mcp', false);
    assert.equal(vscodeEntry.client, 'vscode');
    assert.equal(mcpEntry.client, 'mcp');
});

test('a reference with no symbol (e.g. a file-level item) keeps symbol undefined, not dropped', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({ items: [makeItem({ symbol: undefined })] }),
        makeGateResult(),
        'vscode',
        false
    );
    assert.equal(entry.references.length, 1);
    assert.equal(entry.references[0].symbol, undefined);
});

// --- reference capping (live-tested bug: get_last_chat_evidence overflowed
// to 220,020 chars / 7,713 lines from just 2 stored entries, 461 and 502
// references each -- confirmed a storage-side issue, buildEntry had no cap) ---

function manyItems(count: number, filePrefix: string): EvidenceItem[] {
    return Array.from({ length: count }, (_, i) => makeItem({
        id: `${filePrefix}_${i}`, file: `${filePrefix}_${i}.ts`, startLine: 1, endLine: 1, symbol: `sym_${i}`
    }));
}

test('buildEntry caps references per KIND, not as a flat total -- reproduces and fixes the real CraftConnect shape (128 items / 374 facts)', () => {
    // Mirrors the real live bug's proportions closely enough to prove the
    // point: items alone already exceed any reasonable flat cap, so a flat
    // slice(0, 50) on [...items, ...facts] (items always listed first)
    // would return zero fact references. Verified this is exactly what the
    // real stored entries looked like (109/352 and 128/374 items/facts).
    const entry = buildEntry(
        'q', 'a',
        makePacket({ items: manyItems(128, 'item'), facts: manyItems(374, 'fact') }),
        makeGateResult(),
        'mcp',
        false
    );

    const items = entry.references.filter(r => r.kind === 'item');
    const facts = entry.references.filter(r => r.kind === 'fact');
    assert.equal(items.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND, 'items must be capped, not passed through uncapped');
    assert.equal(facts.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND, 'facts must still be represented, not zeroed out by items alone exceeding a flat cap');
    assert.equal(entry.references.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND * 2);
});

test('buildEntry keeps the FIRST N of each kind (keep-first) -- packet.items/facts arrive already relevance-ranked by EvidencePacketBuilder, so this is keep-most-relevant, not arbitrary', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({ items: manyItems(30, 'item'), facts: [] }),
        makeGateResult(),
        'mcp',
        false
    );
    assert.equal(entry.references.length, QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND);
    assert.deepEqual(entry.references.map(r => r.symbol), Array.from({ length: QUERY_EVIDENCE_MAX_REFERENCES_PER_KIND }, (_, i) => `sym_${i}`));
});

test('buildEntry does not cap when under the limit -- a small real answer is untouched', () => {
    const entry = buildEntry(
        'q', 'a',
        makePacket({ items: manyItems(3, 'item'), facts: manyItems(2, 'fact') }),
        makeGateResult(),
        'mcp',
        false
    );
    assert.equal(entry.references.length, 5);
});

test('capReferencesByKind: mixed-order input still caps each kind independently regardless of interleaving', () => {
    const refs: QueryEvidenceReference[] = [];
    for (let i = 0; i < 40; i++) {
        refs.push({ file: `i${i}.ts`, startLine: 1, endLine: 1, type: 'function', kind: 'item' });
        refs.push({ file: `f${i}.ts`, startLine: 1, endLine: 1, type: 'constant', kind: 'fact' });
    }
    const capped = capReferencesByKind(refs, 10);
    assert.equal(capped.filter(r => r.kind === 'item').length, 10);
    assert.equal(capped.filter(r => r.kind === 'fact').length, 10);
});

test('capReferencesByKind: an entry with only facts (zero items) still returns up to the per-kind cap of facts, not zero', () => {
    const refs: QueryEvidenceReference[] = Array.from({ length: 60 }, (_, i) => ({ file: `f${i}.ts`, startLine: 1, endLine: 1, type: 'constant', kind: 'fact' as const }));
    const capped = capReferencesByKind(refs, 25);
    assert.equal(capped.length, 25);
});

// --- exportQueryEvidence / readQueryEvidence ---

function makeTempRepoguideDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-queryevidence-'));
}

function entryFor(question: string): ReturnType<typeof buildEntry> {
    return buildEntry(question, `answer to ${question}`, makePacket(), makeGateResult(), 'vscode', false);
}

test('exportQueryEvidence on a workspace with no prior file creates it with exactly one entry', async () => {
    const dir = makeTempRepoguideDir();
    try {
        await exportQueryEvidence(dir, entryFor('first question'));
        const entries = await readQueryEvidence(dir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].question, 'first question');
        assert.ok(fs.existsSync(path.join(dir, QUERY_EVIDENCE_FILENAME)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('exportQueryEvidence creates repoguideDir itself if it does not exist yet', async () => {
    const parent = makeTempRepoguideDir();
    const dir = path.join(parent, 'not-created-yet', '.repoguide');
    try {
        await exportQueryEvidence(dir, entryFor('q'));
        assert.ok(fs.existsSync(path.join(dir, QUERY_EVIDENCE_FILENAME)));
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('entries roll over newest-first: the most recently exported entry is always at index 0', async () => {
    const dir = makeTempRepoguideDir();
    try {
        await exportQueryEvidence(dir, entryFor('one'));
        await exportQueryEvidence(dir, entryFor('two'));
        await exportQueryEvidence(dir, entryFor('three'));

        const entries = await readQueryEvidence(dir);
        assert.deepEqual(entries.map(e => e.question), ['three', 'two', 'one']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test(`caps at ${QUERY_EVIDENCE_MAX_ENTRIES} entries -- older entries roll off, newest survive`, async () => {
    const dir = makeTempRepoguideDir();
    try {
        for (let i = 1; i <= QUERY_EVIDENCE_MAX_ENTRIES + 5; i++) {
            await exportQueryEvidence(dir, entryFor(`q${i}`));
        }
        const entries = await readQueryEvidence(dir);
        assert.equal(entries.length, QUERY_EVIDENCE_MAX_ENTRIES);
        // Newest first: q20, q19, ... down to q6 (the oldest 5, q1-q5, rolled off).
        assert.equal(entries[0].question, `q${QUERY_EVIDENCE_MAX_ENTRIES + 5}`);
        assert.equal(entries[entries.length - 1].question, 'q6');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a corrupt existing file (invalid JSON) is recovered from by starting fresh, not by throwing', async () => {
    const dir = makeTempRepoguideDir();
    try {
        fs.writeFileSync(path.join(dir, QUERY_EVIDENCE_FILENAME), '{ this is not valid json', 'utf8');
        await assert.doesNotReject(() => exportQueryEvidence(dir, entryFor('recovered')));

        const entries = await readQueryEvidence(dir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].question, 'recovered');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an existing file that parses but is not an array (e.g. some other tool wrote an object) is treated as empty, not thrown on', async () => {
    const dir = makeTempRepoguideDir();
    try {
        fs.writeFileSync(path.join(dir, QUERY_EVIDENCE_FILENAME), JSON.stringify({ unexpected: 'shape' }), 'utf8');
        await exportQueryEvidence(dir, entryFor('recovered'));

        const entries = await readQueryEvidence(dir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].question, 'recovered');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readQueryEvidence on a directory with no file at all returns an empty array, not an error', async () => {
    const dir = makeTempRepoguideDir();
    try {
        const entries = await readQueryEvidence(dir);
        assert.deepEqual(entries, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
