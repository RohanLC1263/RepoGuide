import test from 'node:test';
import * as assert from 'node:assert/strict';
import { assessEvidenceRelevance, significantTerms } from '../../mcp/evidenceRelevance';
import { EvidenceItem } from '../../query/evidencePacket';

/**
 * The measured failure: get_facts("NoSuchSymbolZZZ") returned 49,762 chars of real facts
 * about unrelated symbols, with the query term absent from the response. Nothing errored --
 * which is exactly what makes it dangerous to a calling model.
 */

function item(symbol: string, file: string, content: string): EvidenceItem {
    return {
        id: symbol + file, symbol, file, startLine: 1, endLine: 5,
        role: 'implementation' as never, type: 'function', content,
        retrieval_signal: 'fact_store', score: 1, confidence: 1,
        extractionMethod: 'tree_sitter' as never
    } as EvidenceItem;
}

const UNRELATED = [
    item('Button', 'components/button.tsx', 'forwardRef<HTMLButtonElement, ButtonProps>'),
    item('resources', 'src/i18n.ts', 'export const resources = { en: {} }')
];

test('a query matching nothing yields verdict none, however much was returned', () => {
    const r = assessEvidenceRelevance('NoSuchSymbolZZZ', UNRELATED);
    assert.equal(r.verdict, 'none');
    assert.equal(r.matchedItems, 0);
    assert.equal(r.totalItems, 2);
    assert.match(r.note, /NOT evidence for this query/);
});

test('a direct symbol hit yields verdict exact', () => {
    const items = [...UNRELATED, item('MIN_RESOLUTION_PX', 'app/agents/image_quality_agent.py', 'MIN_RESOLUTION_PX = 1000')];
    const r = assessEvidenceRelevance('MIN_RESOLUTION_PX', items);
    assert.equal(r.verdict, 'exact');
    assert.equal(r.matchedItems, 1);
});

test('term mentions without a direct hit yield verdict partial', () => {
    const items = [item('handler', 'app/routers/mission.py', 'def handler(): # mission sealing happens here')];
    const r = assessEvidenceRelevance('mission sealing', items);
    assert.equal(r.verdict, 'partial');
    assert.equal(r.matchedItems, 1);
});

test('an empty result set is none, not a crash', () => {
    const r = assessEvidenceRelevance('anything', []);
    assert.equal(r.verdict, 'none');
    assert.equal(r.totalItems, 0);
});

test('a query of only stopwords cannot be assessed, and says so rather than claiming a match', () => {
    const r = assessEvidenceRelevance('the and for', UNRELATED);
    assert.equal(r.verdict, 'partial');
    assert.match(r.note, /no distinctive terms/);
});

test('matching is case-insensitive and reaches file paths and content, not just symbols', () => {
    assert.equal(assessEvidenceRelevance('BUTTON', UNRELATED).matchedItems, 1);
    assert.equal(assessEvidenceRelevance('i18n', UNRELATED).matchedItems, 1);
    assert.equal(assessEvidenceRelevance('forwardRef', UNRELATED).matchedItems, 1);
});

test('stopwords are excluded so a common word cannot manufacture relevance', () => {
    const terms = significantTerms('what does the file for this class get');
    assert.deepEqual(terms, []);
});

test('the verdict is a field a caller can branch on, not prose to parse', () => {
    const r = assessEvidenceRelevance('NoSuchSymbolZZZ', UNRELATED);
    assert.ok(['exact', 'partial', 'none'].includes(r.verdict));
    assert.equal(typeof r.matchedItems, 'number');
    assert.ok(Array.isArray(r.queryTerms));
});
