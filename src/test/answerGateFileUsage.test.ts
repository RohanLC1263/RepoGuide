import test from 'node:test';
import * as assert from 'node:assert/strict';
import { AnswerGate, detectFileUsageClaims, FileUsageGraphLookup } from '../query/answerGate';
import { EvidencePacket } from '../query/evidencePacket';
import { EvidencePlan } from '../query/evidencePlanTypes';

// The file-usage claim verifier: when an answer affirmatively asserts a specific
// FILE is used/imported by other code but the program graph shows no other file
// imports it, that is a contradiction (the reproduced CraftConnect dead-code
// community_engine.py "actively used" failure). Scoped to FILE subjects; symbol
// claims and entry points are deliberately excluded to avoid false positives on
// framework-wired symbols and run-not-imported entry files.

function basePlan(mode: EvidencePlan['confidence_mode'] = 'grounded'): EvidencePlan {
    return {
        originalQuery: 'q', normalizedQuery: 'q', queryType: 'behavior_explanation' as any,
        requiredEvidence: [], symbolHints: [], fileHints: [], phrases: [], factTypes: [],
        unitTypes: [], fileScope: 'implementation_only' as any, retrievalStrategy: 'default' as any,
        mustExcludeRoles: [], diagnostics: [], confidence_mode: mode
    } as EvidencePlan;
}
// Include cited files as evidence so the (separate) file-path attribution check is
// satisfied -- otherwise it blocks first and we can't observe the file-usage check.
function packet(citedFiles: string[] = []): EvidencePacket {
    const items = citedFiles.map((f, i) => ({
        id: 'it' + i, file: f, startLine: 1, endLine: 1, role: 'implementation' as any,
        type: 'file', content: `contents of ${f}`, retrieval_signal: 'lance_store',
        score: 0.9, confidence: 1, extractionMethod: 'tree_sitter' as any
    }));
    return { query: 'q', plan: basePlan(), items: items as any, facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: [] };
}
// Mock graph: maps file path -> importer file paths. Missing key => no importers.
function graph(map: Record<string, string[]>): FileUsageGraphLookup {
    return { getDependents: (s: string) => ({ importers: (map[s] ?? []).map(filePath => ({ filePath })) }) };
}

test('detectFileUsageClaims: catches affirmative file-usage claim, extracts the file subject', () => {
    const claims = detectFileUsageClaims('Based on the evidence, `app/core/community_engine.py` appears to be actively used in the running application.');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].subject, 'app/core/community_engine.py');
});

test('detectFileUsageClaims: ignores NEGATED usage claims (honest "not used")', () => {
    assert.equal(detectFileUsageClaims('The file `foo.py` is not used anywhere.').length, 0);
    assert.equal(detectFileUsageClaims('`bar.py` is never imported by other code.').length, 0);
});

test('detectFileUsageClaims: ignores SYMBOL subjects (only file paths are in scope)', () => {
    // `ObservabilityMiddleware` is a symbol, not a file -- graph can miss framework wiring.
    assert.equal(detectFileUsageClaims('The `ObservabilityMiddleware` is used throughout the app.').length, 0);
    assert.equal(detectFileUsageClaims('`someHelper` is called in many places.').length, 0);
});

test('verify: dead file asserted "actively used" -> revise + unsupported claim + caveat (rc-03 repro)', () => {
    const gate = new AnswerGate();
    const answer = 'Based on the evidence, `app/core/community_engine.py` appears to be actively used in the running application.';
    const r = gate.verify(answer, packet(['app/core/community_engine.py']), undefined, '/ws', graph({}));
    assert.equal(r.outcome, 'revise');
    assert.equal(r.unsupported_claims.length, 1);
    assert.match(r.unsupported_claims[0], /no other code imports it/);
    assert.match(r.finalAnswer, /could not confirm that `app\/core\/community_engine\.py` is actually used/);
});

test('verify: genuinely-imported file asserted "is used" -> NOT flagged (rc-06/rc-10 repro)', () => {
    const gate = new AnswerGate();
    const answer = 'The `interview_db.py` module is used to seed default questions.';
    const r = gate.verify(answer, packet(['interview_db.py']), undefined, '/ws', graph({ 'interview_db.py': ['app/routers/interview.py', 'app/main.py'] }));
    assert.equal(r.outcome, 'pass');
    assert.equal(r.unsupported_claims.length, 0);
});

test('verify: symbol "is used" claim with zero graph edges -> NOT flagged (framework-wiring FP guard, rc-05)', () => {
    const gate = new AnswerGate();
    const answer = 'The `ObservabilityMiddleware` is used for every request.';
    const r = gate.verify(answer, packet(['app/middleware/observability.py']), undefined, '/ws', graph({}));
    assert.equal(r.outcome, 'pass');
    assert.equal(r.unsupported_claims.length, 0);
});

test('verify: entry-point file (main.py) asserted "is used" with no importers -> NOT flagged', () => {
    const gate = new AnswerGate();
    const answer = 'The `app/main.py` file is used as the application entry point.';
    const r = gate.verify(answer, packet(['app/main.py']), undefined, '/ws', graph({}));
    assert.equal(r.outcome, 'pass');
    assert.equal(r.unsupported_claims.length, 0);
});

test('verify: an intra-file edge (importer path == subject file) does not count as external use', () => {
    const gate = new AnswerGate();
    const answer = '`app/core/community_engine.py` is used by the app.';
    // Only "importer" is a unit inside the same file -> still dead externally.
    const r = gate.verify(answer, packet(['app/core/community_engine.py']), undefined, '/ws', graph({ 'app/core/community_engine.py': ['app/core/community_engine.py'] }));
    assert.equal(r.outcome, 'revise');
    assert.equal(r.unsupported_claims.length, 1);
});

test('verify: no graphLookup passed -> file-usage check is skipped entirely (backward compatible)', () => {
    const gate = new AnswerGate();
    const answer = '`app/core/community_engine.py` is actively used.';
    const r = gate.verify(answer, packet(['app/core/community_engine.py']), undefined, '/ws'); // no graphLookup
    assert.equal(r.outcome, 'pass');
    assert.equal(r.unsupported_claims.length, 0);
});
