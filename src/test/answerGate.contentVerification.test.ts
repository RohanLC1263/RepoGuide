import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AnswerGate } from '../query/answerGate';
import { EvidencePacket, EvidenceItem } from '../query/evidencePacket';
import { EvidencePlan } from '../query/evidencePlanTypes';

const FIXTURE_DIR = path.resolve(__dirname, '../../src/test/fixtures', 'craftconnect-hallucination-repro');
const ORCHESTRATOR_AGENT_PATH = path.join(FIXTURE_DIR, 'orchestrator_agent.py');
const MISSION_ORCHESTRATOR_PATH = path.join(FIXTURE_DIR, 'mission_orchestrator.py');
const STORY_GEN_AGENT_PATH = path.join(FIXTURE_DIR, 'story_gen_agent.py');
const STORY_GENERATION_AGENT_PATH = path.join(FIXTURE_DIR, 'story_generation_agent.py');

function basePlan(): EvidencePlan {
    return {
        originalQuery: 'test query',
        normalizedQuery: 'test query',
        queryType: 'architecture' as any,
        requiredEvidence: [],
        symbolHints: [],
        fileHints: [],
        factTypes: [],
        unitTypes: [],
        fileScope: 'workspace' as any,
        retrievalStrategy: 'hybrid' as any,
        mustExcludeRoles: [],
        diagnostics: [],
        confidence_mode: 'exact'
    };
}

function item(overrides: Partial<EvidenceItem>): EvidenceItem {
    return {
        id: 'item-1',
        file: '',
        startLine: 1,
        endLine: 1,
        role: 'implementation',
        type: 'snippet',
        content: '',
        retrieval_signal: 'test',
        score: 1,
        confidence: 1,
        extractionMethod: 'heuristic',
        ...overrides
    };
}

function packet(items: EvidenceItem[]): EvidencePacket {
    return {
        query: 'test query',
        plan: basePlan(),
        items,
        facts: [],
        coverage: [],
        gaps: [],
        diagnostics: [],
        coverageScore: 1,
        matchedEvidenceTypes: []
    };
}

test('AnswerGate blocks a real quote misattributed to the wrong cited file (orchestrator reproduction)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'stub', file: 'orchestrator_agent.py', content: 'class OrchestratorAgent:\n    def __init__(self, *args, **kwargs):\n        raise RuntimeError("Legacy OrchestratorAgent has been removed.")' }),
        item({ id: 'real', file: 'mission_orchestrator.py', content: 'def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):\n    super().__init__(**kwargs)' })
    ]);

    // Fabricated: quotes mission_orchestrator.py's real __init__ but attributes it to orchestrator_agent.py
    const answer = 'orchestrator_agent.py: "def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):"';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('does not appear in that file') && d.includes('orchestrator_agent.py')));
});

test('AnswerGate passes a quote correctly attributed to its real file (no false positive)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'stub', file: 'orchestrator_agent.py', content: 'class OrchestratorAgent:\n    def __init__(self, *args, **kwargs):\n        raise RuntimeError("Legacy OrchestratorAgent has been removed.")' })
    ]);

    // Correct: quotes orchestrator_agent.py's real content, attributes it to the same file
    const answer = 'orchestrator_agent.py: "def __init__(self, *args, **kwargs):"';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'pass');
    assert.ok(result.supported_claims.some(c => c.startsWith('Quote:')));
});

test('AnswerGate blocks a false "identical" claim between two real, differently-sized files (story-agent reproduction)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'a', file: 'story_generation_agent.py', content: 'class StoryGenerationAgent(BaseAgent):' }),
        item({ id: 'b', file: 'story_gen_agent.py', content: 'class StoryGenAgent:' })
    ]);

    const answer = 'Both story_generation_agent.py and story_gen_agent.py contain identical code -- there is no functional difference between them.';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('identical/equivalent') && d.includes('story_generation_agent.py')));
});

test('AnswerGate does not flag a legitimate claim of difference as a false equivalence claim', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'a', file: 'story_generation_agent.py', content: 'class StoryGenerationAgent(BaseAgent):' }),
        item({ id: 'b', file: 'story_gen_agent.py', content: 'class StoryGenAgent:' })
    ]);

    const answer = 'story_generation_agent.py and story_gen_agent.py are different -- the first is the real implementation, the second is a deprecated shim.';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.notEqual(result.outcome, 'block');
});

test('AnswerGate skips attribution check gracefully when no workspaceRoot is provided (relative paths unresolvable)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'stub', file: 'app/agents/orchestrator_agent.py', content: 'raises RuntimeError' }),
        item({ id: 'real', file: 'app/agents/mission_orchestrator.py', content: 'def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):' })
    ]);
    const answer = 'app/agents/orchestrator_agent.py: "def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):"';

    // No workspaceRoot passed -- relative evidence paths can't be resolved to disk, so the
    // attribution check should degrade gracefully (fall through to the pre-existing
    // "does this quote appear anywhere in evidence" check) rather than throwing.
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
});

test('AnswerGate uses absolute evidence file paths directly without needing workspaceRoot', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'stub', file: ORCHESTRATOR_AGENT_PATH, content: 'class OrchestratorAgent:' }),
        item({ id: 'real', file: MISSION_ORCHESTRATOR_PATH, content: 'def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):' })
    ]);
    const answer = `${path.basename(ORCHESTRATOR_AGENT_PATH)}: "def __init__(self, classifier_agent, rag_agent, story_agent, packager_agent, auth_validator_agent, **kwargs):"`;

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
});

// --- Direct verification against the real, byte-copied CraftConnect files ---
// (not synthetic recreations -- these are the actual files that produced the
// original fabrications, per the investigation report's requirement)

test('Real fixture files: orchestrator_agent.py and mission_orchestrator.py are confirmed genuinely different', () => {
    const fs = require('fs');
    const stub = fs.readFileSync(ORCHESTRATOR_AGENT_PATH, 'utf8');
    const real = fs.readFileSync(MISSION_ORCHESTRATOR_PATH, 'utf8');
    assert.ok(stub.includes('RuntimeError'));
    assert.ok(!stub.includes('classifier_agent'));
    assert.ok(real.includes('classifier_agent'));
});

test('Real fixture files: story_gen_agent.py and story_generation_agent.py are confirmed genuinely different', () => {
    const fs = require('fs');
    const shim = fs.readFileSync(STORY_GEN_AGENT_PATH, 'utf8');
    const real = fs.readFileSync(STORY_GENERATION_AGENT_PATH, 'utf8');
    assert.ok(shim.includes('DEPRECATED'));
    assert.notEqual(shim.replace(/\r\n/g, '\n').trimEnd(), real.replace(/\r\n/g, '\n').trimEnd());
});

test('AnswerGate against real fixture content: misattributed quote from mission_orchestrator.py to orchestrator_agent.py is blocked', () => {
    const fs = require('fs');
    const gate = new AnswerGate();
    const realOrchestratorContent = fs.readFileSync(MISSION_ORCHESTRATOR_PATH, 'utf8') as string;
    const initSnippetMatch = realOrchestratorContent.match(/def __init__\([\s\S]{0,120}/);
    assert.ok(initSnippetMatch, 'fixture file should contain a real __init__ signature to quote');
    const realSnippet = initSnippetMatch![0].replace(/"/g, "'");

    const pkt = packet([
        item({ id: 'stub', file: 'orchestrator_agent.py', content: fs.readFileSync(ORCHESTRATOR_AGENT_PATH, 'utf8') }),
        item({ id: 'real', file: 'mission_orchestrator.py', content: realOrchestratorContent })
    ]);
    const answer = `orchestrator_agent.py: "${realSnippet}"`;

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'block');
});

// --- Fenced code block verification (Track 4 false-negative fix) ---
// Reproduces the exact MissionOrchestratorAgent case found while verifying the Track 4
// prompt redesign: a "here's a simplified example" fenced code block containing the real
// __init__ signature PLUS a fabricated execute_mission method and fabricated calls, none
// of which are in the evidence packet. Before this fix, AnswerGate never looked at fenced
// (```...```) code at all -- only double-quoted "..." strings -- so this passed silently.

const REAL_MISSION_ORCHESTRATOR_INIT = `def __init__(
    self,
    classifier_agent,
    rag_agent,
    story_agent,
    packager_agent,
    auth_validator_agent,
    image_quality_agent=None,
    artisan_trust_agent=None,
    listing_assistant=None,
    marketplace_agent=None,
    market_agent=None,
    visual_grounding_agent=None,
    **kwargs`;

test('AnswerGate blocks a fabricated method inside a fenced code block (MissionOrchestratorAgent reproduction)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'mo-2', file: 'app/agents/mission_orchestrator.py', content: REAL_MISSION_ORCHESTRATOR_INIT })
    ]);

    const answer = 'Here is a simplified example of how this might look in code:\n\n' +
        '```python\n' +
        'class MissionOrchestratorAgent:\n' +
        '    ' + REAL_MISSION_ORCHESTRATOR_INIT.split('\n').join('\n    ') + '\n' +
        '    ):\n' +
        '        self.classifier_agent = classifier_agent\n\n' +
        '    def execute_mission(self, image):\n' +
        '        # Example workflow\n' +
        '        classification_result = self.classifier_agent.classify(image)\n' +
        '        retrieval_result = self.rag_agent.retrieve(classification_result)\n' +
        '        story = self.story_agent.generate(retrieval_result)\n' +
        '        report = self.packager_agent.package(story)\n' +
        '        return report\n' +
        '```\n\nThis modular approach ensures maintainability.';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Fenced code block does not match any evidence')));
});

test('AnswerGate passes a fenced code block that genuinely quotes real evidence content', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'mo-2', file: 'app/agents/mission_orchestrator.py', content: REAL_MISSION_ORCHESTRATOR_INIT })
    ]);

    const answer = 'The constructor signature is:\n\n```python\n' + REAL_MISSION_ORCHESTRATOR_INIT + '\n```\n\nThis wires up each dependent agent.';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.notEqual(result.outcome, 'block');
    assert.ok(result.supported_claims.some(c => c.startsWith('Fenced code block:')));
});

test('AnswerGate blocks a fenced code block whose real content is misattributed to the wrong cited file', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'stub', file: 'orchestrator_agent.py', content: 'class OrchestratorAgent:\n    def __init__(self, *args, **kwargs):\n        raise RuntimeError("Legacy OrchestratorAgent has been removed.")' }),
        item({ id: 'real', file: 'mission_orchestrator.py', content: REAL_MISSION_ORCHESTRATOR_INIT })
    ]);

    // The fenced code is real (matches mission_orchestrator.py) but falsely attributed to orchestrator_agent.py
    const answer = 'orchestrator_agent.py contains:\n\n```python\n' + REAL_MISSION_ORCHESTRATOR_INIT + '\n```';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Fenced code block attributed to orchestrator_agent.py')));
});

test('AnswerGate ignores a trivial, sub-threshold fenced code block (not worth a disk re-read)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'a', file: 'a.ts', content: 'const x = 1;' })
    ]);
    const answer = 'You can do this:\n\n```\nx\n```\n\nThat is all.';

    const result = gate.verify(answer, pkt, undefined, FIXTURE_DIR);
    assert.notEqual(result.outcome, 'block');
});

// --- Numeric-claim line-span tolerance (Pass 1-approved fix for the httpx/httpclient
// block-rate regression found while verifying Track 4: richer synthesis led the model to
// cite specific in-function line numbers that aren't a literal substring of the evidence
// blob -- only the cited item's own startLine-endLine boundary text is -- so the whole,
// otherwise-correct answer was being blocked on that single unsupported-looking number). ---

test('AnswerGate tolerates an in-span "at line N" citation even though N is not a literal substring of the evidence', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'send-1', file: 'httpx/_client.py', startLine: 878, endLine: 927, content: 'def send(self, request):\n    ...\n    response = self._send_single_request(request)\n    ...' })
    ]);
    const answer = 'The send method performs the actual network write at line 900, inside the retry loop.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
    assert.ok(result.supported_claims.some(c => c === 'Numeric: 900'));
});

test('AnswerGate tolerates an in-span hyphenated line range even though the endpoints are not literal substrings', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'send-2', file: 'httpx/_client.py', startLine: 1593, endLine: 1642, content: 'async def send(self, request):\n    ...' })
    ]);
    const answer = 'A second implementation spans lines 1615-1616, handling the async variant.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
});

test('AnswerGate still blocks a bare numeric claim that happens to fall in an item span but has no line-number context', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        // Deliberately large span so "42" would fall inside it purely by coincidence --
        // the fix must require line-number CONTEXT (line/lines/at line/hyphenated range),
        // not just numeric proximity to any cited item's boundaries.
        item({ id: 'router-1', file: 'llm_router.py', startLine: 1, endLine: 1000, content: 'fallback_order.extend(["groq", "gemini", "ollama", "mock"])' })
    ]);
    const answer = 'There are 42 fallback backends configured in this router.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Unsupported numeric claim: 42')));
});

test('AnswerGate still blocks an out-of-span line-number citation (line context present, but the number is outside every cited item\'s range)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'send-1', file: 'httpx/_client.py', startLine: 10, endLine: 20, content: 'def send(self, request):\n    ...' })
    ]);
    const answer = 'The real write happens at line 900, far outside the cited snippet.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
});

// --- Fallback-chain cursor fix (the third AnswerGate check found to over-block Track 4's
// more connective, narrative synthesis style: a symbol repeated across multiple
// fallback_chain facts was being compared against its own static first occurrence every
// time via answer.indexOf(f.symbol), so a legitimately-repeated class/function name in a
// longer answer got flagged as "out of order" against itself, over and over). ---

function fallbackFact(symbol: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
    return item({ id: `fb-${symbol}-${Math.random()}`, type: 'fallback_chain', symbol, content: symbol, ...overrides });
}

test('AnswerGate does not flag a symbol repeated across 4+ fallback-chain facts as out of order against itself (reproduction)', () => {
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            fallbackFact('Client'),
            fallbackFact('Client'),
            fallbackFact('Client'),
            fallbackFact('Client'),
            fallbackFact('Timeout'),
            fallbackFact('Request'),
            fallbackFact('HTTPTransport')
        ]
    };

    // "Client" is genuinely mentioned four times across a longer, connective explanation,
    // each time further along in the text -- not a reordering, just natural repetition.
    const answer = 'The Client class sends requests. Internally, Client builds a Request object, ' +
        'then Client delegates to the transport, and Client finally awaits the response. ' +
        'A Timeout can occur during this. The Request itself carries the URL. ' +
        'The underlying HTTPTransport performs the actual network write.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
    assert.ok(!result.diagnostics.some(d => d.includes('appeared out of order')));
});

test('AnswerGate still blocks a genuine fallback-chain reordering', () => {
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            fallbackFact('Groq'),
            fallbackFact('Gemini')
        ]
    };

    // Chain expects Groq before Gemini, but the answer discusses Gemini first.
    const answer = 'The router falls back to Gemini first, and only tries Groq afterward.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Gemini appeared out of order')));
});

test('AnswerGate does not flag a fallback-chain symbol that is simply absent from the answer', () => {
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            fallbackFact('Groq'),
            fallbackFact('Gemini'),
            fallbackFact('Ollama')
        ]
    };

    const answer = 'The router tries Groq first, then Gemini.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
});

test('AnswerGate does not flag disconnected fallback-chain facts from unrelated files sharing a generic symbol name (real CraftConnect reproduction)', () => {
    // Reproduces a real regression found dogfooding the fallback-chain fix against
    // CraftConnect: a broad retrieval pulled fallback_chain-typed facts from two
    // genuinely unrelated files that both happen to reference a common, generic
    // symbol ("key") -- auth.py's token verification and community_engine.py's JWKS
    // cache handling are not the same chain, just two unrelated pieces of code that
    // both mention "key". The prior (unscoped) fix still treated every fallback_chain
    // fact in the whole packet as one global ordered sequence, so this was flagged
    // "out of order" 7 times in the real transcript even though nothing was reordered
    // -- there was no real chain connecting these facts in the first place.
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            fallbackFact('key', { file: 'app/core/auth.py', unitId: 'app/core/auth.py::get_current_user::function::1' }),
            fallbackFact('key', { file: 'app/core/community_engine.py', unitId: 'app/core/community_engine.py::verify_jwks::function::1' }),
            fallbackFact('key', { file: 'app/core/auth.py', unitId: 'app/core/auth.py::get_current_user::function::1' })
        ]
    };

    // The answer discusses "key" multiple times across explaining two unrelated
    // mechanisms -- not a reordering of any single real chain.
    const answer = 'auth.py\'s get_current_user reads the bearer token and validates it against the signing key. ' +
        'Separately, community_engine.py caches the JWKS key set with a TTL before auth.py can use a fresh key on the next request.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
    assert.ok(!result.diagnostics.some(d => d.includes('appeared out of order')));
});

test('AnswerGate still catches a genuine reordering within one real chain even when an unrelated fact shares its symbol name', () => {
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            // The real chain: Groq before Gemini, both from the same unit.
            fallbackFact('Groq', { unitId: 'router-unit-1' }),
            fallbackFact('Gemini', { unitId: 'router-unit-1' }),
            // An unrelated fact from a different unit sharing a generic name --
            // must not interfere with checking the real chain above.
            fallbackFact('key', { unitId: 'unrelated-unit-2' })
        ]
    };

    // Chain expects Groq before Gemini, but the answer discusses Gemini first --
    // a genuine reordering within the real chain, must still be caught.
    const answer = 'The router falls back to Gemini first, and only tries Groq afterward. The key is read separately.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('appeared out of order')));
});

test('AnswerGate does not flag byte-identical duplicate fallback-chain facts for the same unit (real CraftConnect reproduction, rc-09)', () => {
    // Reproduces the exact rc-09 case found dogfooding: querying CraftConnect's real
    // facts.db for factType='fallback_chain' AND symbol='key' returned 7 rows, 5 of them
    // completely identical (same unitId "...chart.tsx::key::constant_block::183", same
    // symbol) -- the same source location was fact-extracted multiple times, unrelated
    // to the auth question actually being asked (a frontend chart.tsx component, pulled
    // in as noise evidence). The unit/file-scoped grouping fix alone was not enough:
    // even correctly grouped together, 5 facts demanding 5 separate forward occurrences
    // of "key" for an answer that only mentions it once each got flagged as "out of
    // order" in turn -- confirmed in the real transcript as 7 identical diagnostic lines.
    const gate = new AnswerGate();
    const pkt: EvidencePacket = {
        ...packet([]),
        facts: [
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::183' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::183' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::183' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::183' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::183' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::279' }),
            fallbackFact('key', { unitId: 'chart.tsx::key::constant_block::279' })
        ]
    };

    const answer = 'The signing key is validated against the token, but the evidence does not determine what verify_token adds beyond that.';

    const result = gate.verify(answer, pkt);
    assert.notEqual(result.outcome, 'block');
    assert.ok(!result.diagnostics.some(d => d.includes('appeared out of order')));
});
