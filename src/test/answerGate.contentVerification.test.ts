import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import { AnswerGate } from '../query/answerGate';
import { EvidencePacket, EvidenceItem } from '../query/evidencePacket';
import { EvidencePlan } from '../query/evidencePlanTypes';

const FIXTURE_DIR = path.resolve(__dirname, '../../src/test/fixtures', 'craftconnect-hallucination-repro');
const ORCHESTRATOR_AGENT_PATH = path.join(FIXTURE_DIR, 'orchestrator_agent.py');
const MISSION_ORCHESTRATOR_PATH = path.join(FIXTURE_DIR, 'mission_orchestrator.py');
const STORY_GEN_AGENT_PATH = path.join(FIXTURE_DIR, 'story_gen_agent.py');
const STORY_GENERATION_AGENT_PATH = path.join(FIXTURE_DIR, 'story_generation_agent.py');

const FENCE_FIXTURE_DIR = path.resolve(__dirname, '../../src/test/fixtures', 'craftconnect-fence-repro');
const MISSION_COORDINATOR_PATH = path.join(FENCE_FIXTURE_DIR, 'mission_coordinator.py');
const PACKAGER_AGENT_PATH = path.join(FENCE_FIXTURE_DIR, 'packager_agent.py');
const ARTIFACT_MANAGER_PATH = path.join(FENCE_FIXTURE_DIR, 'artifact_manager.py');
const LISTING_CONTENT_ASSISTANT_PATH = path.join(FENCE_FIXTURE_DIR, 'listing_content_assistant.py');

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

test('AnswerGate explains an indexing-excluded path instead of the raw "Unsupported path" string (fc-05 reproduction)', () => {
    // Reproduces fc-05 from the fresh dogfood pass: mission_orchestrator.backup.py is
    // real on disk but deliberately excluded from indexing by fileWalker's *.backup.py
    // pattern, so it can never appear in evidence. The old diagnostic surfaced the raw
    // internal string "Unsupported path: backup.py" (FILE_PATH_REGEX stops at the last
    // dot-segment) -- technically true, useless to a developer looking at that file.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'real', file: 'app/agents/mission_orchestrator.py', content: 'class MissionOrchestratorAgent: pass' })
    ]);

    const answer = 'The file app/agents/mission_orchestrator.backup.py is not referenced by the running app.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('mission_orchestrator.backup.py') && d.includes('exclusion pattern')));
    assert.ok(!result.diagnostics.some(d => d.startsWith('Unsupported path:')));
});

test('AnswerGate accepts a real quote re-indented by one space (fc-09 reproduction)', () => {
    // The real file/evidence carries the docstring at 8-space indentation; the model
    // quoted it at 7. The old raw-substring comparison blocked the whole (correct)
    // answer on that one-space difference.
    const gate = new AnswerGate();
    const pkt = packet([
        item({
            id: 'delegation',
            file: 'app/agents/mission_orchestrator.py',
            content: 'async def generate_listing_from_interview(self, mission_id):\n        """\n        Delegates to MissionCoordinator.\n        """\n        return await self.coordinator.generate_listing_from_interview(mission_id)'
        })
    ]);

    const answer = 'The method\'s docstring says "\n       Delegates to MissionCoordinator.\n       " which confirms the wrapping relationship.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('AnswerGate does not manufacture pseudo-quotes from docstrings inside fenced code blocks (fc-09 reproduction)', () => {
    // A Python """docstring""" inside a fence pairs the naive "..." regex across the
    // fence boundary, producing a giant fake "quote" mixing code and prose that can
    // never match evidence. Fence content is verified by the fence check; the prose
    // quote scan must skip it.
    const gate = new AnswerGate();
    const realContent = 'async def generate_listing_from_interview(self, mission_id):\n    """Delegates to MissionCoordinator."""\n    return await self.coordinator.generate_listing_from_interview(mission_id)';
    const pkt = packet([
        item({ id: 'delegation', file: 'app/agents/mission_orchestrator.py', content: realContent })
    ]);

    const answer = [
        'The orchestrator wraps the coordinator:',
        '```python',
        realContent,
        '```',
        'So one wraps the other.'
    ].join('\n');

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('AnswerGate does not attribute a fence to a file named only AFTER it (fc-09 reproduction)', () => {
    // The fence's own caption names no file; the next list item's prose names a
    // DIFFERENT file. The old after-window fallback attributed the fence to that
    // next file and blocked verbatim-real code as "misattributed".
    const gate = new AnswerGate();
    const studioWriteContent = 'result = await global_state.orchestrator.generate_listing_from_interview(\n    mission_id,\n    interview_data\n)';
    const orchestratorContent = 'async def generate_listing_from_interview(self, mission_id):\n    """Delegates to MissionCoordinator."""\n    return await self.coordinator.generate_listing_from_interview(mission_id)';
    const pkt = packet([
        item({ id: 'sw', file: 'app/routers/studio_write.py', content: studioWriteContent }),
        item({ id: 'mo', file: 'app/agents/mission_orchestrator.py', content: orchestratorContent })
    ]);

    const answer = [
        'The call within the endpoint function:',
        '```python',
        studioWriteContent,
        '```',
        '',
        'Meanwhile, in mission_orchestrator.py, the method is defined as:',
        '```python',
        orchestratorContent,
        '```'
    ].join('\n');

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.diagnostics.some(d => d.includes('does not appear in that file')));
});

test('AnswerGate still blocks a fence misattributed via a file named BEFORE it (control)', () => {
    const gate = new AnswerGate();
    const realA = 'def alpha_handler(request):\n    return alpha_service.process(request)';
    const realB = 'def beta_handler(request):\n    return beta_service.process(request)';
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const nodeOs = require('node:os');
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'gate-fence-attrib-'));
    nodeFs.writeFileSync(nodePath.join(dir, 'alpha.py'), realA);
    nodeFs.writeFileSync(nodePath.join(dir, 'beta.py'), realB);
    const pkt = packet([
        item({ id: 'a', file: 'alpha.py', content: realA }),
        item({ id: 'b', file: 'beta.py', content: realB })
    ]);

    // Real code from beta.py, explicitly attributed to alpha.py in the caption BEFORE the fence.
    const answer = `In alpha.py the handler is:\n\`\`\`python\n${realB}\n\`\`\``;

    const result = gate.verify(answer, pkt, undefined, dir);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('alpha.py') && d.includes('does not appear in that file')));
});

test('AnswerGate still blocks a genuinely fabricated quote after whitespace normalization', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'real', file: 'app/agents/mission_orchestrator.py', content: 'class MissionOrchestratorAgent: pass' })
    ]);

    const answer = 'The code clearly says "this method frobnicates the quantum lattice before dispatch" internally.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('AnswerGate accepts a data-artifact filename that appears only inside evidence CONTENT (sub-4/fc-09 reproduction)', () => {
    // mission_report.json is never an evidence FILE -- it exists only as a string
    // literal in the code that writes it. The old files-only check deterministically
    // blocked a correct persistence answer 6/6 runs (measured, subTaskFlakinessProbe).
    const gate = new AnswerGate();
    const pkt = packet([
        item({
            id: 'save',
            file: 'app/agents/artifact_manager.py',
            content: 'self.artifact_manager.save_artifact(\n    mission_id, "", "mission_report.json", report.model_dump(), validate=False\n)'
        })
    ]);

    const answer = 'The final report is written to mission_report.json in the mission directory by artifact_manager.py.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.diagnostics.some(d => d.includes('Unsupported path')));
});

test('AnswerGate still reports a plain hallucinated path with the generic unsupported-path diagnostic', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ id: 'real', file: 'app/agents/mission_orchestrator.py', content: 'class MissionOrchestratorAgent: pass' })
    ]);

    const answer = 'The logic lives in totally_invented_controller.py, which handles the upload.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d === 'Unsupported path: totally_invented_controller.py'));
});

// --- Symbol-anchored numeric contradiction check ---
//
// Real data, not synthetic: queried CraftConnect's actual .repoguide/facts.db
// directly (LIKE '%confidence_threshold%') during the capability audit that
// found this bug. app/agents/customization_interview_agent.py:65 contains
// `self.confidence_threshold = 0.55  # Raised from 0.10 -- filters out weak
// STT transcriptions` -- the real, live-enforced value, extracted as a real
// numeric_threshold fact (symbol="self.confidence_threshold", value=0.55).
// The same file's docstring (lines 206/219) separately describes an older
// design using 0.70 as an EXAMPLE return value in prose -- never a fact,
// only present in raw evidence content, since a docstring is a string-literal
// node a tree-sitter assignment walk never descends into.
function numericThresholdFact(symbol: string, value: number, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
    return item({ id: `nt-${symbol}-${value}`, type: 'numeric_threshold', symbol, content: String(value), ...overrides });
}

const REAL_CONFIDENCE_THRESHOLD_FACT = numericThresholdFact('self.confidence_threshold', 0.55, {
    file: 'app/agents/customization_interview_agent.py',
    startLine: 65
});

test('INDUCED FAILURE: a stale-docstring value (0.70) that contradicts the real live assignment (0.55) is caught and blocked, with zero prior diagnostics', () => {
    // The exact real sentence from the capability audit (audit-03), which
    // previously passed with zero diagnostics -- confirmed via the real
    // pipeline before this fix existed.
    const gate = new AnswerGate();
    const pkt = packet([
        item({
            file: 'app/agents/customization_interview_agent.py',
            content: 'Returns (Success - confidence >= 0.70): ...\nReturns (Retry Required - confidence < 0.70): ...'
        })
    ]);
    (pkt as EvidencePacket).facts = [REAL_CONFIDENCE_THRESHOLD_FACT];

    const answer = 'It checks the confidence score of the transcription. If the confidence is below a certain threshold (0.70 in this case), it returns a retry response indicating that the answer needs to be re-recorded.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(
        result.diagnostics.some(d => d.includes('contradicts the actual value of "self.confidence_threshold"') && d.includes('0.55') && d.includes('customization_interview_agent.py:65')),
        `expected a contradiction diagnostic naming the real value, got: ${JSON.stringify(result.diagnostics)}`
    );
});

test('the correct value (0.55) for the exact same real fact and a structurally identical sentence passes clean', () => {
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [REAL_CONFIDENCE_THRESHOLD_FACT];

    const answer = 'If the confidence is below a certain threshold (0.55 in this case), it returns a retry response.';

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(result.supported_claims.some(c => c === 'Numeric: 0.55'));
});

test('duplicate identical facts for the same symbol (a real, confirmed CraftConnect data quirk) do not falsely register as ambiguous', () => {
    // The real facts.db query returned this exact fact TWICE (byte-identical) --
    // an existing, separate data-quality issue, not something this check should
    // be fooled by into treating as "two different values, therefore ambiguous."
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [
        REAL_CONFIDENCE_THRESHOLD_FACT,
        numericThresholdFact('self.confidence_threshold', 0.55, { id: 'nt-dupe', file: 'app/agents/customization_interview_agent.py', startLine: 65 })
    ];

    const wrongAnswer = 'The threshold (0.70 in this case) triggers a retry.';
    const wrongResult = gate.verify(wrongAnswer, pkt);
    assert.equal(wrongResult.outcome, 'block');

    const rightAnswer = 'The threshold (0.55 in this case) triggers a retry.';
    const rightResult = gate.verify(rightAnswer, pkt);
    assert.equal(rightResult.outcome, 'pass');
});

test('a shared generic word alone (e.g. "confidence") does NOT falsely match an unrelated fact -- ALL distinctive words must be present', () => {
    // Reproduces a real false-attribution found on the first live run of this
    // check: "confidence_threshold" and an unrelated frontend "confidence_score"
    // state variable share the single generic word "confidence". Requiring only
    // one shared word let the check block a genuinely wrong claim but cite the
    // wrong fact as the contradiction. ALL word tokens must now match.
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('confidence_score', 0, { file: 'craftconnect-frontend/src/contexts/StudioContext.tsx', startLine: 382 })
    ];

    // "confidence" appears, but "score" never does -- confidence_score must NOT match.
    const answer = 'If the confidence is below a certain threshold (0.70 in this case), it returns a retry response.';
    const result = gate.verify(answer, pkt);
    assert.ok(!result.diagnostics.some(d => d.includes('contradicts the actual value')), `expected no false attribution to the unrelated fact, got: ${JSON.stringify(result.diagnostics)}`);
});

test('genuinely ambiguous nearby facts (two different symbols, all of both symbols\' words present, different values) do not trigger a false contradiction', () => {
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('self.max_retry_count', 5, { file: 'app/agents/customization_interview_agent.py', startLine: 70 }),
        numericThresholdFact('self.min_retry_count', 2, { file: 'app/agents/customization_interview_agent.py', startLine: 71 })
    ];

    // "max"/"min" are both < 4 chars so they're not distinctive tokens on their
    // own -- both facts' only >=4-char word is "retry"/"count", so both match,
    // with two DIFFERENT values (5 and 2). Must not guess which one 7 refers to.
    const answer = 'The retry count (7 in this case) controls how many attempts are allowed.';
    const result = gate.verify(answer, pkt);
    assert.ok(!result.diagnostics.some(d => d.includes('contradicts the actual value')), `expected no contradiction diagnostic on genuine ambiguity, got: ${JSON.stringify(result.diagnostics)}`);
});

test('a numeric claim with no nearby symbol-bearing fact is unaffected by the contradiction check (existing behavior)', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ content: 'Architecture revolves around 5 files as structural entry points.' })
    ]);
    (pkt as EvidencePacket).facts = [REAL_CONFIDENCE_THRESHOLD_FACT];

    const answer = 'Architecture revolves around 5 files as structural entry points.';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(result.supported_claims.some(c => c === 'Numeric: 5'));
});

test('a real, correctly-cited numeric_threshold fact value with NO nearby symbol mention still passes via the existing content check (contradiction check does not regress plain support)', () => {
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [REAL_CONFIDENCE_THRESHOLD_FACT];

    // 0.55 is correct AND present, but nothing symbol-shaped is nearby -- must
    // still pass via the pre-existing supportedByContent path, unaffected.
    const answer = 'The value used here is 0.55, based on internal tuning.';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
});

// --- f-string / template-literal paraphrase check ---

test('INDUCED FAILURE reproduction: a correctly-paraphrased f-string with a filled-in example value is no longer blocked (audit-04)', () => {
    // The exact real evidence line from customization_interview_agent.py:282 and
    // the exact real answer sentence from the capability audit (audit-04), which
    // previously blocked with "Unsupported quoted string" before this fix.
    const gate = new AnswerGate();
    const pkt = packet([
        item({
            file: 'app/agents/customization_interview_agent.py',
            content: `'message': f"We couldn't hear you clearly (confidence: {confidence:.0%}). Please try again.",`
        })
    ]);

    const answer = `The server returns an error message: "We couldn't hear you clearly (confidence: 70%). Please try again."`;

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('a template match still requires the surrounding literal text to match exactly -- only the placeholder is free to vary', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ content: `f"We couldn't hear you clearly (confidence: {confidence:.0%}). Please try again."` })
    ]);

    // Same template, but the model changed the surrounding wording -- must still block.
    const answer = `The message says: "Sorry, we could not understand you (confidence: 70%). Try once more."`;
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('a quote unrelated to any real template, and not present verbatim, still blocks as fabricated', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ content: `class Foo:\n    def bar(self):\n        return "unrelated real string"` })
    ]);

    const answer = 'The code clearly says "this method frobnicates the quantum lattice before dispatch" internally.';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Unsupported quoted string')));
});

test('INDUCED FAILURE reproduction: a generic single-word symbol ("base", 4 chars) does not falsely anchor an unrelated number (live audit-04 rerun finding)', () => {
    // Real data: app/services/stt_service.py:210 has `base = 0.60`, a local
    // variable inside an unrelated confidence-scoring heuristic. Live testing of
    // the contradiction check (after the earlier "confidence_score" fix) found
    // this: a totally unrelated answer sentence mentioning "4" and "5" attempts
    // got blocked as "contradicting base=0.6", because the answer's evidence
    // discussion elsewhere happened to mention the word "base" nearby, and a
    // bare 4-character single-word symbol had no specificity bar to clear.
    const gate = new AnswerGate();
    const pkt = packet([]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('base', 0.6, { file: 'app/services/stt_service.py', startLine: 210 })
    ];

    const answer = 'The base retry logic allows the user up to 4 attempts, capped at a maximum of 5.';
    const result = gate.verify(answer, pkt);
    assert.ok(!result.diagnostics.some(d => d.includes('contradicts the actual value')), `expected no false attribution to the generic "base" symbol, got: ${JSON.stringify(result.diagnostics)}`);
});

test('a JS/TS template literal with ${...} interpolation is also recognized', () => {
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'src/errors.ts', content: 'throw new Error(`Request failed with status ${response.status}`);' })
    ]);

    const answer = 'It throws an error: "Request failed with status 404".';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass');
});

test('INDUCED FAILURE reproduction: a compound symbol whose short prefix ("min_") is stripped to a single generic word ("words") does not falsely anchor an unrelated number (audit-05 decomposition-merge finding)', () => {
    // Real data: app/llm_backends/mock_backend.py:155 has `min_words = 95`, a
    // local variable inside a MOCK backend's word-count padding loop --
    // completely unrelated to any interview/retry mechanics. Before this fix,
    // symbolProximityTokens' >= 4 char word filter dropped "min" (3 chars),
    // leaving only "words" -- a maximally generic English word -- as the sole
    // thing the AND-match required nearby, so a markdown numbered list item
    // that merely mentioned "words" in an unrelated sentence falsely collided.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/llm_backends/mock_backend.py', content: 'min_words = 95' })
    ]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('min_words', 95, { file: 'app/llm_backends/mock_backend.py', startLine: 155 })
    ];

    const answer = '3. **completeInterview**: This function marks the interview as complete by sending a POST request. It logs a summary using a few words to confirm success.';
    const result = gate.verify(answer, pkt);
    assert.ok(!result.diagnostics.some(d => d.includes('contradicts the actual value')), `expected no false attribution to the generic-after-stripping "min_words" symbol, got: ${JSON.stringify(result.diagnostics)}`);
});

test('a genuine contradiction on a short-prefix compound symbol ("min_words") is still caught when both "min" and "words" are actually present nearby (control)', () => {
    // Same real fact as above, but the answer this time genuinely makes a claim
    // ABOUT min_words specifically (both "min" and "words" appear near the
    // wrong number) -- the fix must not have disabled the check for this
    // symbol shape entirely, only stopped it from matching on "words" alone.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/llm_backends/mock_backend.py', content: 'min_words = 95' })
    ]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('min_words', 95, { file: 'app/llm_backends/mock_backend.py', startLine: 155 })
    ];

    const answer = 'The mock backend pads its generated summary until it reaches a minimum of 30 words, to satisfy the length validator.';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('contradicts the actual value of "min_words"')), `expected the genuine min_words contradiction to still be caught, got: ${JSON.stringify(result.diagnostics)}`);
});

// --- Markdown ordered-list-marker exclusion ---
//
// Found via a fresh 15-question real-world eval against CraftConnect: 8/14
// questions abstained with gap diagnostics shaped like "Numeric claim 1
// contradicts...", "Numeric claim 2 contradicts...", "Numeric claim 3
// contradicts..." -- sequential small integers, each blocked against a fact
// in a file often unrelated to the question's actual topic. Root-caused via
// a live merge-step answer whose own numbered list ("1. **submitAnswer**:
// ...", "2. **apiFetch**: ...") produced exactly this diagnostic shape, with
// "1" attributed to an unrelated "answered" fact merely proximate in the
// text. numberRegex (`/\b\d+(\.\d+)?\b/g`) has no awareness of markdown
// syntax, so an ordered-list marker's digit was read as a bare numeric claim
// like any other.

test('INDUCED FAILURE reproduction: a 3-item numbered list with an unrelated fact no longer blocks on the list markers themselves', () => {
    // The exact minimal reproduction from the investigation: three ordered-
    // list items with bolded method names, and one real but topically
    // unrelated numeric_threshold fact. Before this fix, "1", "2", and "3"
    // (the list markers) were each read as bare numeric claims and blocked
    // against MAX_UPLOAD_SIZE_MB in sequence -- exactly the reported
    // "Numeric claim 1/2/3 contradicts..." shape.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/config/upload_limits.py', content: 'MAX_UPLOAD_SIZE_MB = 25' })
    ]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('MAX_UPLOAD_SIZE_MB', 25, { file: 'app/config/upload_limits.py', startLine: 4 })
    ];

    const answer = `The image upload flow involves several steps:

1. **validate_upload_size**: Checks the file size against the configured MAX_UPLOAD_SIZE_MB limit before accepting the upload.
2. **generate_thumbnail**: Creates a downscaled preview image.
3. **store_to_bucket**: Persists the original file to cloud storage.
`;

    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'pass', `expected the list-marker digits to be excluded from numeric-claim checking entirely, got diagnostics: ${JSON.stringify(result.diagnostics)}`);
});

test('control: a genuine numeric claim starting a line, but NOT followed by ". " or ") ", is still checked normally (not mistaken for a list marker)', () => {
    // "30 seconds is the timeout..." starts a line with a digit, same as a
    // list marker would -- but the digit is followed by " seconds", not
    // ". "/") ", so isListMarkerContext must not exclude it. A genuinely
    // wrong claim here (30 vs the real value 45) must still be caught.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/config/timeouts.py', content: 'TIMEOUT_SECONDS = 45' })
    ]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('TIMEOUT_SECONDS', 45, { file: 'app/config/timeouts.py', startLine: 3 })
    ];

    const answer = '30 seconds is the timeout for the retrieval step, per TIMEOUT_SECONDS.';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('contradicts the actual value of "TIMEOUT_SECONDS"')), `expected the genuine line-initial contradiction to still be caught, got: ${JSON.stringify(result.diagnostics)}`);
});

test('control: a real contradicting number INSIDE a numbered list item (not the marker itself) is still caught', () => {
    // "1." is a legitimate list marker (correctly excluded), but "90" inside
    // that same item's text is a genuine, wrong claim about a real symbol --
    // confirms the exclusion is precise to the marker digit, not the whole
    // line or list item.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/agents/customization_interview_agent.py', content: 'self.confidence_threshold = 0.55' })
    ]);
    (pkt as EvidencePacket).facts = [
        numericThresholdFact('self.confidence_threshold', 0.55, { file: 'app/agents/customization_interview_agent.py', startLine: 65 })
    ];

    const answer = `The interview flow works as follows:

1. **checkConfidence**: Requires a confidence_threshold of at least 0.90 before accepting an answer, per self.confidence_threshold.
2. **retryAnswer**: Resets state for a retry.
`;
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('contradicts the actual value of "self.confidence_threshold"')), `expected the genuine in-item contradiction to still be caught, got: ${JSON.stringify(result.diagnostics)}`);
});

// --- Fence/quote per-file attribution tolerance for resolved templates and
// non-contiguous-but-real reproductions ---
//
// Found via a fresh 15-question CraftConnect eval, after the list-marker fix:
// 4 of the 6 remaining abstentions all blocked with "Fenced code block does
// not match any evidence content -- likely fabricated illustrative code." (or
// the parallel quote-misattribution message). Re-running each question with
// AnswerGate.verify() intercepted to capture the raw pre-gate answer (the
// gate discards it on block) and comparing line-by-line against the real,
// fresh-from-disk file it was attributed to found 3 of the 4 were false
// positives -- every line individually verbatim-real, but the block as a
// whole non-contiguous via placeholder resolution, line-flattening, or a
// single omitted intervening line -- and 1 (the JSON-fallback question) was a
// genuine catch of a wrong answer (a real string from elsewhere in the same
// file, assigned to the wrong field).

test('INDUCED FAILURE reproduction: a quote whose number is a resolved f-string placeholder, attributed to its real source file, is not misattributed-blocked (classification-timeout finding)', () => {
    // Real case: mission_coordinator.py raises
    // f"Classification timed out after {TIMEOUT_CLASSIFICATION}s" -- the
    // model correctly explained this with the resolved value "60s". The
    // evidence-wide quote check already tolerates this (matchesTemplateInContent),
    // but the PER-FILE attribution check (verifying the claimed file actually
    // contains it) did a literal substring comparison only, blocking a fully
    // correct answer.
    const gate = new AnswerGate();
    const realContent = fs.readFileSync(MISSION_COORDINATOR_PATH, 'utf8');
    const pkt = packet([
        item({ file: MISSION_COORDINATOR_PATH, content: realContent })
    ]);
    const answer = 'If `self.container.classifier.classify(c_input)` times out after `TIMEOUT_CLASSIFICATION` (60 seconds) in `mission_coordinator.py`, an `asyncio.TimeoutError` is raised. This exception is caught, and a new `Exception` is raised with the message "Classification timed out after 60s". The final status property of the returned `MissionReport` will be set to `MissionStatus.FAILED`.';
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'pass', `expected the resolved-placeholder quote to be tolerated against its real attributed file, got: ${JSON.stringify(result.diagnostics)}`);
});

test('INDUCED FAILURE reproduction: a fenced code block flattening a real multi-line f-string concatenation with literal "\\n" text, and eliding intermediate real lines, is not fabrication-blocked (WhatsApp prompt finding)', () => {
    // Real case: packager_agent.py builds its WhatsApp prompt from several
    // separate f-string lines concatenated together. The model correctly
    // quoted 3 of those real lines but flattened them into ONE fence line
    // using literal "\n" as a human-readable separator (not an actual
    // newline) and dropped the PRICE/GUIDELINES lines in between.
    const gate = new AnswerGate();
    const realContent = fs.readFileSync(PACKAGER_AGENT_PATH, 'utf8');
    const pkt = packet([
        item({ file: PACKAGER_AGENT_PATH, content: realContent })
    ]);
    const answer = 'Based on the evidence provided:\n\n1. The exact prompt constraint given for WhatsApp messages in PackagerAgent is:\n```\nWrite a short, shareable WhatsApp message for selling a {title}.\\nSTORY CONTEXT: {description[:800]}\\n- End with a Call to Action (DM for details).\\n\n```\n\n2. The exact fallback text used if the _generate_social_content LLM call completely fails is:\n```\n🎨 *{title}*\\n\\n{description[:200]}...\n```';
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'pass', `expected the flattened-but-real fence to be tolerated, got: ${JSON.stringify(result.diagnostics)}`);
});

test('INDUCED FAILURE reproduction: a fenced code block with verbatim, correctly-ordered real lines but one omitted intervening line is not fabrication-blocked (atomic-write finding)', () => {
    // Real case: artifact_manager.py's _save_atomic() has a bare `try:` line
    // between two real lines the model quoted verbatim and in order -- the
    // model's illustrative fence dropped just that one structural line.
    const gate = new AnswerGate();
    const realContent = fs.readFileSync(ARTIFACT_MANAGER_PATH, 'utf8');
    const pkt = packet([
        item({ file: ARTIFACT_MANAGER_PATH, content: realContent })
    ]);
    const answer = `The _save_atomic() method in ArtifactManager implements an atomic save using tempfile.NamedTemporaryFile(). To create a temporary file in the same directory as the target file, it uses:
\`\`\`python
import tempfile
prefix = f".tmp_{path.name}_"
with tempfile.NamedTemporaryFile(mode, delete=False, dir=dir_name, prefix=prefix, suffix=".tmp", encoding="utf-8") as tmp:
\`\`\`
Finally, it performs an atomic move:
\`\`\`python
os.replace(tmp_path, path)
logger.debug(f"Atomically wrote to {path}")
\`\`\`
`;
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'pass', `expected the real-but-non-contiguous (one omitted line) fence to be tolerated, got: ${JSON.stringify(result.diagnostics)}`);
});

test('control: a fenced code block asserting a real string from elsewhere in the file for the WRONG field is still caught (JSON-fallback finding)', () => {
    // Real case: the ground truth fallback "title" is
    // f"{craft_name} | Handmade Traditional Wall Art | Authentic Indian Heritage".
    // The model instead claimed the title is populated with rejection_text --
    // a real string, but from a different method entirely, assigned to the
    // wrong field. This composite line exists nowhere in the real file
    // (rejection_text is never assigned to "title"), so it must stay blocked
    // even with the new per-line-in-order tolerance.
    const gate = new AnswerGate();
    const realContent = fs.readFileSync(LISTING_CONTENT_ASSISTANT_PATH, 'utf8');
    const pkt = packet([
        item({ file: LISTING_CONTENT_ASSISTANT_PATH, content: realContent })
    ]);
    const answer = `The "title" field in the fallback data structure is populated with a specific string when an exception occurs during JSON parsing in ListingContentAssistant.generate_draft().

Here's the relevant code snippet from the evidence:

\`\`\`python
rejection_text = f"We currently do not have sufficient authoritative information about this {craft_name} to provide a detailed description. This may be a rare or regional variation not yet documented in our knowledge base."
\`\`\`

So, if an exception occurs during JSON parsing, the fallback data structure will have:

\`\`\`json
"title": "We currently do not have sufficient authoritative information about this {craft_name} to provide a detailed description. This may be a rare or regional variation not yet documented in our knowledge base."
\`\`\`
`;
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'block');
    assert.ok(result.diagnostics.some(d => d.includes('Fenced code block does not match any evidence content')), `expected the wrong-field composite line to still be blocked as fabricated, got: ${JSON.stringify(result.diagnostics)}`);
});

test('the fence PER-FILE attribution branch (not just the evidence-wide check) also tolerates a resolved f-string placeholder', () => {
    // Isolates the fence-attribution branch specifically: the fence check's
    // control flow only reaches the per-file attribution branch once the
    // evidence-wide check has ALREADY passed -- so a second, unrelated
    // evidence item literally contains the resolved text (satisfying the
    // evidence-wide check via plain substring match), while the file claimed
    // for attribution (mission_coordinator.py) is read FRESH FROM DISK by
    // the gate, independent of what's in packet.items, and only has the
    // unresolved {TIMEOUT_CLASSIFICATION} placeholder -- so the per-file
    // branch's own tolerance is what's actually being exercised here.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/agents/some_other_file.py', content: 'raise Exception(f"Classification timed out after 60s")' }),
        item({ file: MISSION_COORDINATOR_PATH, content: 'placeholder' })
    ]);
    const answer = 'Per mission_coordinator.py, the exact raised exception is:\n```python\nraise Exception(f"Classification timed out after 60s")\n```\n';
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'pass', `expected the fence-attribution branch's own template tolerance to fire, got: ${JSON.stringify(result.diagnostics)}`);
});

test('the fence PER-FILE attribution branch also tolerates a real, correctly-ordered reproduction with one omitted intervening line', () => {
    // Same isolation strategy as above: a second, unrelated-file evidence
    // item literally contains the fence's exact (contiguous) text, so the
    // evidence-wide check passes via the pre-existing literal check -- the
    // claimed file (artifact_manager.py) is read fresh from disk, where the
    // real content has an intervening `try:` line the fence omits, so only
    // the per-file branch's new fenceLinesMatchInOrder tolerance can pass it.
    const gate = new AnswerGate();
    const pkt = packet([
        item({
            file: 'app/services/some_other_file.py',
            content: 'import tempfile\nprefix = f".tmp_{path.name}_"\nwith tempfile.NamedTemporaryFile(mode, delete=False, dir=dir_name, prefix=prefix, suffix=".tmp", encoding="utf-8") as tmp:'
        }),
        item({ file: ARTIFACT_MANAGER_PATH, content: 'placeholder' })
    ]);
    const answer = `Per artifact_manager.py, the temp file is created with:
\`\`\`python
import tempfile
prefix = f".tmp_{path.name}_"
with tempfile.NamedTemporaryFile(mode, delete=False, dir=dir_name, prefix=prefix, suffix=".tmp", encoding="utf-8") as tmp:
\`\`\`
`;
    const result = gate.verify(answer, pkt, undefined, undefined);
    assert.equal(result.outcome, 'pass', `expected the fence-attribution branch's own line-order tolerance to fire, got: ${JSON.stringify(result.diagnostics)}`);
});

test('disclosed residual: a fenced block made entirely of short, generic lines in coincidentally-plausible order is NOT tolerated (no distinctive line to anchor trust)', () => {
    // The per-line-in-order fallback requires at least one line that is both
    // >= CODE_QUOTE_MIN_LENGTH and not a bare import/try/except-shaped line --
    // without this, a block of only generic fragments (each individually
    // findable ANYWHERE, in countless real files) could pass on structure
    // alone. This test documents the current, intentional behavior rather
    // than proposing a fix for it. The generic lines are deliberately
    // scattered across SEPARATE evidence items (never contiguous with each
    // other) so the pre-existing whole-block contiguous check can't
    // accidentally pass this by coincidence, isolating the new per-line
    // fallback's own (correct) refusal.
    const gate = new AnswerGate();
    const pkt = packet([
        item({ file: 'app/a.py', content: 'import tempfile' }),
        item({ file: 'app/b.py', content: 'try:' }),
        item({ file: 'app/c.py', content: 'except Exception:' })
    ]);
    const answer = 'The real implementation looks like:\n```python\nimport tempfile\ntry:\nexcept Exception:\n```\n';
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'block', 'a generic-only fence must not be tolerated even if every fragment happens to match somewhere');
    assert.ok(result.diagnostics.some(d => d.includes('Fenced code block does not match any evidence content')));
});

// --- Conceptual-mode fence remediation (annotate + revise instead of silent pass) ---
//
// The fences and evidence below are verbatim from the live P1 broad-architecture
// reproduction (2026-07-09): a fully fabricated ListingContentAssistant.generate_draft
// (invented DraftInput/DraftOutput types, zero hits anywhere in CraftConnect) passed the
// gate because conceptual mode recorded the failure but never enforced anything, while a
// REAL MissionCoordinator fence in the same answer -- its multi-line __init__ signature
// flattened onto one line by the model -- proved that simply enabling blocking in
// conceptual mode would over-block real-but-paraphrased code.

const ANNOTATION_PHRASE = 'could not verify this code block against the indexed evidence';

/** Real generate_draft signature (as in the live evidence packet). */
const REAL_LISTING_ASSISTANT_EVIDENCE = [
    'class ListingContentAssistant:',
    '    """',
    '    Helps artisans draft marketplace listings.',
    '    """',
    '    AGENT_VERSION = "2.0.0"',
    '',
    '    async def generate_draft(self, craft_identity: str, validated_story: str, readiness_report: MarketplaceReadinessReport, interview_context: str = None, interview_data: Dict[str, Any] = None, visual_grounding_data: Optional[Dict[str, Any]] = None, confirmed_facts: Optional[Dict[str, Any]] = None) -> ListingContentDraft:',
    '        self.logger.info(f"Generating Listing Draft for {craft_identity}")',
    '        craft_name = self._format_craft_name(str(craft_identity))'
].join('\n');

/** Real MissionCoordinator head with the real MULTI-LINE __init__ signature. */
const REAL_MISSION_COORDINATOR_EVIDENCE = [
    'class MissionCoordinator:',
    '    """',
    '    Coordinates the execution of a mission workflow.',
    '    """',
    '',
    '    def __init__(',
    '        self,',
    '        container: AgentContainer,',
    '        artifact_manager: ArtifactManager,',
    '        data_dir: str',
    '    ):',
    '        self.container = container',
    '        self.artifact_manager = artifact_manager',
    '        self.data_dir = Path(data_dir)'
].join('\n');

/** Verbatim fabricated fence from the captured P1 answer (DraftInput/DraftOutput do not exist). */
const FABRICATED_FENCE = [
    '```python',
    'class ListingContentAssistant:',
    '    async def generate_draft(self, input_data: DraftInput) -> DraftOutput:',
    '        craft_identity = input_data.craft_identity',
    '        story_text = input_data.story_text',
    '        draft_content = f"Craft Identity: {craft_identity}"',
    '        return DraftOutput(',
    '            draft_content=draft_content,',
    '            positive_signals=["Draft generated successfully"]',
    '        )',
    '```'
].join('\n');

/** Verbatim flattened-signature fence from the same captured answer: real code, but the model joined the 6-line signature onto one line. */
const FLATTENED_FENCE = [
    '```python',
    'class MissionCoordinator:',
    '    def __init__(self, container: AgentContainer, artifact_manager: ArtifactManager, data_dir: str):',
    '        self.container = container',
    '        self.artifact_manager = artifact_manager',
    '        self.data_dir = Path(data_dir)',
    '```'
].join('\n');

/** A fence that IS a verbatim contiguous excerpt of the evidence above. */
const MATCHING_FENCE = [
    '```python',
    '        self.container = container',
    '        self.artifact_manager = artifact_manager',
    '        self.data_dir = Path(data_dir)',
    '```'
].join('\n');

function conceptualPacket(items: EvidenceItem[]): EvidencePacket {
    const pkt = packet(items);
    pkt.plan.confidence_mode = 'conceptual';
    return pkt;
}

function fenceEvidenceItems(): EvidenceItem[] {
    return [
        item({ id: 'listing', file: 'app/agents/listing_content_assistant.py', content: REAL_LISTING_ASSISTANT_EVIDENCE }),
        item({ id: 'coordinator', file: 'app/agents/orchestrator/mission_coordinator.py', content: REAL_MISSION_COORDINATOR_EVIDENCE })
    ];
}

/** True when the annotation phrase appears within `windowChars` after the fence's end. */
function annotationAdjacent(finalAnswer: string, fence: string, windowChars = 200): boolean {
    const at = finalAnswer.indexOf(fence);
    assert.notEqual(at, -1, 'fence text itself must survive intact in finalAnswer');
    return finalAnswer.slice(at + fence.length, at + fence.length + windowChars).includes(ANNOTATION_PHRASE);
}

test('conceptual mode: a fabricated fence gets revise + an inline annotation adjacent to that fence (P1 DraftInput/DraftOutput reproduction)', () => {
    const gate = new AnswerGate();
    const answer = `The listing flow is orchestrated as follows.\n\n${FABRICATED_FENCE}\n\nThat is the draft generation step.`;
    const result = gate.verify(answer, conceptualPacket(fenceEvidenceItems()));
    assert.equal(result.outcome, 'revise', `expected revise, got ${result.outcome}: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(annotationAdjacent(result.finalAnswer, FABRICATED_FENCE), 'annotation must sit directly after the fabricated fence');
    const count = result.finalAnswer.split(ANNOTATION_PHRASE).length - 1;
    assert.equal(count, 1, 'exactly one annotation for one failing fence');
    assert.ok(result.removed_or_rewritten_claims.some(c => c.includes('Annotated unverified fenced code block')));
});

test('conceptual mode: the flattened-signature REAL fence gets revise (soft flag), never a block (no over-blocking regression)', () => {
    const gate = new AnswerGate();
    const answer = `The coordinator is constructed like this:\n\n${FLATTENED_FENCE}\n`;
    const result = gate.verify(answer, conceptualPacket(fenceEvidenceItems()));
    assert.notEqual(result.outcome, 'block', 'a paraphrased real fence must never hard-block in conceptual mode');
    assert.equal(result.outcome, 'revise');
    assert.ok(annotationAdjacent(result.finalAnswer, FLATTENED_FENCE));
});

test('conceptual mode: annotations are selective -- only failing fences flagged, a genuinely matching fence in the same answer stays clean', () => {
    const gate = new AnswerGate();
    const answer = `Overview.\n\n${FABRICATED_FENCE}\n\nMiddle part.\n\n${FLATTENED_FENCE}\n\nAnd verbatim:\n\n${MATCHING_FENCE}\n\nDone.`;
    const result = gate.verify(answer, conceptualPacket(fenceEvidenceItems()));
    assert.equal(result.outcome, 'revise');
    assert.ok(annotationAdjacent(result.finalAnswer, FABRICATED_FENCE), 'fabricated fence must be annotated');
    assert.ok(annotationAdjacent(result.finalAnswer, FLATTENED_FENCE), 'flattened fence must be annotated');
    assert.ok(!annotationAdjacent(result.finalAnswer, MATCHING_FENCE), 'matching fence must NOT be annotated');
    const count = result.finalAnswer.split(ANNOTATION_PHRASE).length - 1;
    assert.equal(count, 2, 'exactly the two failing fences annotated');
});

test('conceptual mode: an answer with only a matching fence stays an untouched pass (no annotation, no revise)', () => {
    const gate = new AnswerGate();
    const answer = `Construction assigns the dependencies:\n\n${MATCHING_FENCE}\n`;
    const result = gate.verify(answer, conceptualPacket(fenceEvidenceItems()));
    assert.equal(result.outcome, 'pass');
    assert.ok(!result.finalAnswer.includes(ANNOTATION_PHRASE));
    assert.equal(result.finalAnswer, answer, 'finalAnswer must be byte-identical when nothing failed');
});

test('grounded-mode control: both P1 fences still hard-block exactly as before (enforcement in exact/grounded untouched)', () => {
    const gate = new AnswerGate();
    for (const fence of [FABRICATED_FENCE, FLATTENED_FENCE]) {
        const pkt = packet(fenceEvidenceItems());
        pkt.plan.confidence_mode = 'grounded';
        const result = gate.verify(`Here is the code:\n\n${fence}\n`, pkt);
        assert.equal(result.outcome, 'block', `grounded mode must still block: ${fence.slice(0, 60)}`);
        assert.ok(result.diagnostics.some(d => d.includes('likely fabricated illustrative code')));
        assert.ok(!result.finalAnswer.includes(ANNOTATION_PHRASE), 'no annotation on the block path');
    }
});

test('conceptual mode: annotation lands correctly even when the gap-acknowledgement prepend already rewrote finalAnswer (content-anchored, not offset-based)', () => {
    const gate = new AnswerGate();
    const answer = `Confident architecture overview.\n\n${FABRICATED_FENCE}\n`;
    const pkt = conceptualPacket(fenceEvidenceItems());
    pkt.gaps = ['structured gap: symbol not found'];
    const result = gate.verify(answer, pkt);
    assert.equal(result.outcome, 'revise');
    assert.ok(result.finalAnswer.startsWith('The evidence does not determine the full answer due to missing facts. '), 'gap prepend must still fire');
    assert.ok(annotationAdjacent(result.finalAnswer, FABRICATED_FENCE), 'annotation must sit after the fence despite the shifted offsets');
});

test('conceptual mode: duplicate identical failing fences each get their own annotation, in order', () => {
    const gate = new AnswerGate();
    const answer = `First occurrence:\n\n${FABRICATED_FENCE}\n\nRepeated later:\n\n${FABRICATED_FENCE}\n`;
    const result = gate.verify(answer, conceptualPacket(fenceEvidenceItems()));
    assert.equal(result.outcome, 'revise');
    const count = result.finalAnswer.split(ANNOTATION_PHRASE).length - 1;
    assert.equal(count, 2, 'both occurrences annotated');
    const firstEnd = result.finalAnswer.indexOf(FABRICATED_FENCE) + FABRICATED_FENCE.length;
    assert.ok(result.finalAnswer.slice(firstEnd, firstEnd + 200).includes(ANNOTATION_PHRASE), 'first occurrence annotated adjacently');
    const secondAt = result.finalAnswer.indexOf(FABRICATED_FENCE, firstEnd);
    assert.notEqual(secondAt, -1);
    const secondEnd = secondAt + FABRICATED_FENCE.length;
    assert.ok(result.finalAnswer.slice(secondEnd, secondEnd + 200).includes(ANNOTATION_PHRASE), 'second occurrence annotated adjacently');
});
