import test from 'node:test';
import * as assert from 'node:assert/strict';
import { trimEvidenceItemForMcp, trimEvidenceItemsForMcp, MCP_CONTENT_CHAR_CAP } from '../../mcp/evidenceItemTrimmer';
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

// --- content cap: retrieve_raw_evidence/get_facts item content had no length
// bound at all -- live-measured against CraftConnect's real logical_units.db
// up to 80,190 chars for one item (englishTranslations, i18n.ts), and 18,951
// for the 488-line MissionCoordinator class. These tests build synthetic
// multi-line content with an exactly-known line/char structure so the
// resume-line pointer's math can be verified precisely, not just eyeballed.

/** Builds `totalLines` lines, each exactly `lineLength - 1` content chars
 * plus the joining '\n' (so every line "unit" is exactly `lineLength` chars,
 * except the last line has no trailing newline) -- lets a test cap exactly
 * on a line boundary and hand-verify the result. */
function makeFixedWidthContent(totalLines: number, lineLength: number): string {
    const lines = Array.from({ length: totalLines }, (_, i) => `L${i}`.padEnd(lineLength - 1, 'x'));
    return lines.join('\n');
}

function itemWithContent(content: string, startLine: number, endLine: number): EvidenceItem {
    return { ...realShapedItem(), content, startLine, endLine, file: 'src/big.ts' };
}

test('content at or under the cap is left completely unchanged', () => {
    const content = makeFixedWidthContent(10, 100); // 10*100-1 = 999 chars, under the cap
    assert.ok(content.length <= MCP_CONTENT_CHAR_CAP);
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, 1, 10));
    assert.equal(trimmed.content, content);
});

test('content exactly at the cap boundary is left unchanged (strictly greater-than triggers truncation, not >=)', () => {
    const content = 'x'.repeat(MCP_CONTENT_CHAR_CAP);
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, 1, 1));
    assert.equal(trimmed.content, content);
});

test('oversized content is truncated and ends with a RepoGuide truncation note', () => {
    // 40 lines of exactly 100 chars each (99 + \n) = 3999 chars total, well over the cap.
    const content = makeFixedWidthContent(40, 100);
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, 100, 139));
    assert.ok(trimmed.content.length < content.length);
    assert.match(trimmed.content, /\.\.\. \[RepoGuide truncated \d+ of \d+ lines \(\d+ of \d+ chars\)\. Read .+ for the rest\.\] \.\.\.$/);
});

test('resume-line pointer math is exact on a clean line-boundary cut (1500 / 100-char lines = exactly 15 lines)', () => {
    // Reproduces, in miniature, the real off-by-one bug found via live CraftConnect
    // data (i18n.ts's englishTranslations, mission_coordinator.py's MissionCoordinator):
    // an earlier version pointed the "Read X:N-M" note at the LAST line already
    // shown, not the next unread one -- confirmed wrong by spot-checking the real
    // file on disk, where line N was content the client already had.
    const content = makeFixedWidthContent(40, 100);
    const startLine = 100;
    const endLine = 139;
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, startLine, endLine));

    // Exactly 15 complete lines (1500 chars / 100-char lines) must be shown.
    const lines = content.split('\n');
    const shownLines = lines.slice(0, 15).join('\n');
    assert.ok(trimmed.content.startsWith(shownLines), 'expected the first 15 complete lines to be shown verbatim');
    // The 16th line (0-indexed 15, file line 115) must NOT appear anywhere in the shown head.
    const head = trimmed.content.split('... [RepoGuide')[0];
    assert.equal(head.includes(lines[15]), false, 'line 15 (0-indexed) must not have leaked into the shown head');

    const match = trimmed.content.match(/Read (\S+):(\d+)-(\d+) for the rest/);
    assert.ok(match, 'expected a Read pointer in the truncation note');
    const [, file, resumeLineStr, endLineStr] = match!;
    assert.equal(file, 'src/big.ts');
    assert.equal(Number(resumeLineStr), 115, 'resume line must be the FIRST UNSHOWN line (100 + 15), not the last shown one (114)');
    assert.equal(Number(endLineStr), endLine);

    const droppedMatch = trimmed.content.match(/truncated (\d+) of (\d+) lines \((\d+) of (\d+) chars\)/);
    assert.ok(droppedMatch);
    const [, droppedLines, totalLines, droppedChars, totalChars] = droppedMatch!.map(Number as any) as unknown as number[];
    assert.equal(totalLines, 40);
    assert.equal(droppedLines, 25, '40 total - 15 shown = 25 dropped');
    assert.equal(totalChars, content.length);
    assert.equal(droppedChars, content.length - shownLines.length);
});

test('resume-line pointer is still exact when the cap does not land on a clean line boundary', () => {
    // 97-char lines don't divide the 1500 cap evenly -- the cut lands mid-line,
    // and the rounding-down-to-the-last-complete-line logic must still point at
    // the correct next line, not off by one in either direction.
    const content = makeFixedWidthContent(40, 97);
    const startLine = 1;
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, startLine, 40));
    const lines = content.split('\n');

    const match = trimmed.content.match(/Read \S+:(\d+)-\d+ for the rest/);
    assert.ok(match);
    const resumeLine = Number(match![1]);
    const resumeLineIndex = resumeLine - startLine; // 0-indexed position into `lines`

    const head = trimmed.content.split('... [RepoGuide')[0];
    // Every line strictly before the resume line must be fully present in the head...
    assert.ok(head.includes(lines[resumeLineIndex - 1]), 'the line just before the resume pointer must already be shown');
    // ...and the resume line itself (and everything after) must NOT appear in the head.
    assert.equal(head.includes(lines[resumeLineIndex]), false, 'the resume line itself must not already be shown');
});

test('a single line longer than the whole cap (no newline anywhere in the first 1500 chars) resumes at the SAME line, not the next one', () => {
    // Degenerate case: nothing to round down to. The shown text is only a partial
    // prefix of startLine itself, so the client must re-read from that same line,
    // not skip past it.
    const hugeFirstLine = 'x'.repeat(2500);
    const content = hugeFirstLine + '\n' + 'second line here';
    const trimmed = trimEvidenceItemForMcp(itemWithContent(content, 50, 51));

    assert.equal(trimmed.content.startsWith('x'.repeat(MCP_CONTENT_CHAR_CAP)), true);
    const match = trimmed.content.match(/Read \S+:(\d+)-(\d+) for the rest/);
    assert.ok(match);
    assert.equal(Number(match![1]), 50, 'must resume at the SAME line (50), not 51 -- the line was only partially shown');
    assert.equal(Number(match![2]), 51);
});

test('content cap is applied identically for get_facts-shaped items (same trimEvidenceItemForMcp call, no separate path)', () => {
    const content = makeFixedWidthContent(30, 100);
    const item: EvidenceItem = { ...realShapedItem(), content, type: 'assignment', retrieval_signal: 'fact_store_direct' };
    const trimmed = trimEvidenceItemForMcp(item);
    assert.match(trimmed.content, /RepoGuide truncated/);
});
