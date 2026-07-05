import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AnswerGate } from '../query/answerGate';
import { EvidencePacket, EvidenceItem } from '../query/evidencePacket';
import { EvidencePlan } from '../query/evidencePlanTypes';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'craftconnect-hallucination-repro');
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
