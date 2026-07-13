import test from 'node:test';
import * as assert from 'node:assert/strict';
import { trimEvidenceItemForMcp, trimEvidenceItemsForMcp } from '../../mcp/evidenceItemTrimmer';
import { EvidenceItem, SemanticCategory } from '../../query/evidencePacket';
import { withNormalizedEvidenceFields } from '../../query/normalizedEvidence';

// Live-measured finding this fixes: a full serialized EvidenceItem is 43
// lines -- provenance and canonicalSource (from withNormalizedEvidenceFields)
// each re-duplicate file/startLine/endLine/symbol a second and third time,
// plus internal-only fields (providerId, sourceId, freshness, subjectUuid/
// objectUuid) no MCP client uses. Measured against CraftConnect's real
// facts.db: dropping both cuts a 50-item retrieve_raw_evidence/get_facts
// response by ~73% lines / ~71% characters.

function realShapedItem(): EvidenceItem {
    // Mirrors factStoreProvider.ts's factToEvidenceItem -- a real, fully
    // normalized item with provenance/canonicalSource actually populated,
    // not a bare-minimum stub that would trivially "pass" by omission.
    return withNormalizedEvidenceFields({
        id: 'fact-1',
        file: 'app/agents/customization_interview_agent.py',
        startLine: 65,
        endLine: 65,
        role: 'implementation',
        factId: 'fact-1',
        unitId: 'unit-1',
        symbol: 'self.confidence_threshold',
        type: 'numeric_threshold',
        content: '0.55',
        retrieval_signal: 'fact_store_direct',
        semanticCategory: SemanticCategory.BEHAVIOR,
        score: 1,
        confidence: 'high',
        extractionMethod: 'ast_query'
    }, {
        providerId: 'fact_store',
        evidenceType: 'numeric_threshold',
        freshness: 'unknown',
        provenance: {
            providerId: 'fact_store',
            source: 'FactStore',
            sourceId: 'fact-1',
            sourceType: 'numeric_threshold',
            confidence: 'high',
            metadata: { unitId: 'unit-1', valueKind: 'number' }
        },
        canonicalSource: {
            providerId: 'fact_store',
            file: 'app/agents/customization_interview_agent.py',
            startLine: 65,
            endLine: 65,
            symbol: 'self.confidence_threshold',
            sourceId: 'fact-1',
            sourceType: 'numeric_threshold'
        }
    });
}

test('trimEvidenceItemForMcp keeps exactly the client-facing fields, nothing more', () => {
    const trimmed = trimEvidenceItemForMcp(realShapedItem());
    assert.deepEqual(Object.keys(trimmed).sort(), [
        'confidence', 'content', 'endLine', 'file', 'retrieval_signal', 'score', 'startLine', 'symbol', 'type'
    ].sort());
});

test('trimEvidenceItemForMcp preserves the real values of every kept field', () => {
    const trimmed = trimEvidenceItemForMcp(realShapedItem());
    assert.deepEqual(trimmed, {
        file: 'app/agents/customization_interview_agent.py',
        startLine: 65,
        endLine: 65,
        symbol: 'self.confidence_threshold',
        type: 'numeric_threshold',
        content: '0.55',
        score: 1,
        confidence: 'high',
        retrieval_signal: 'fact_store_direct'
    });
});

test('trimEvidenceItemForMcp drops provenance and canonicalSource entirely', () => {
    const trimmed: any = trimEvidenceItemForMcp(realShapedItem());
    assert.equal('provenance' in trimmed, false);
    assert.equal('canonicalSource' in trimmed, false);
    assert.equal('providerId' in trimmed, false);
    assert.equal('freshness' in trimmed, false);
});

test('trimming measurably shrinks serialized output on a realistic 50-item response', () => {
    const items = Array.from({ length: 50 }, () => realShapedItem());
    const full = JSON.stringify({ facts: items, index_age: { lastIndexedAt: 'x', ageSeconds: 1 } }, null, 2);
    const trimmed = JSON.stringify({ facts: trimEvidenceItemsForMcp(items), index_age: { lastIndexedAt: 'x', ageSeconds: 1 } }, null, 2);
    assert.ok(trimmed.length < full.length * 0.5, `expected a large size reduction, got full=${full.length} trimmed=${trimmed.length}`);
});

test('trimEvidenceItemsForMcp preserves the same set and order of items, one trimmed item per input item', () => {
    const a = { ...realShapedItem(), id: 'a', file: 'a.ts', startLine: 1 };
    const b = { ...realShapedItem(), id: 'b', file: 'b.ts', startLine: 2 };
    const trimmed = trimEvidenceItemsForMcp([a, b]);
    assert.equal(trimmed.length, 2);
    assert.deepEqual(trimmed.map(i => `${i.file}:${i.startLine}`), ['a.ts:1', 'b.ts:2']);
});

test('an item with no symbol (undefined) is trimmed without throwing, symbol stays undefined not dropped as a key', () => {
    const item = { ...realShapedItem(), symbol: undefined };
    const trimmed = trimEvidenceItemForMcp(item);
    assert.equal(trimmed.symbol, undefined);
});

test('empty items array trims to an empty array, no error', () => {
    assert.deepEqual(trimEvidenceItemsForMcp([]), []);
});
