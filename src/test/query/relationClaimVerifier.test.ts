import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectRelationClaims,
    usesSymbolInCodePosition,
    stripCommentsAndStrings,
    verifyRelationClaims
} from '../../query/relationClaimVerifier';

/**
 * Pins the relation-claim verifier against the two measured fabrication classes.
 *
 * The source snippets below are VERBATIM from real CraftConnect files (verified 2026-08-04),
 * not invented fixtures -- they are the exact shapes that make this check hard: a docstring
 * mention, a log-message mention that reads like a call, and a definition-only file.
 */

// --- detection -------------------------------------------------------------

test('detect: the dominant recorded fabrication shape (file + predicate + backticked symbol)', () => {
    const answer = 'The `PackagerAgent` in `app/agents/packager_agent.py` calls the `execute` method to package content.';
    const claims = detectRelationClaims(answer);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].file, 'app/agents/packager_agent.py');
    assert.equal(claims[0].symbol, 'execute');
});

test('detect: negated clauses are honest denials, never claims', () => {
    const answer = 'The file `app/agents/packager_agent.py` does not call the `execute` method.';
    assert.deepEqual(detectRelationClaims(answer), []);
});

test('detect: clause-bounded -- a file in one sentence never pairs with a symbol in the next', () => {
    // Precision guard: without the [^.\n] bound these two sentences would fuse into a claim.
    const answer = 'See `app/core/auth.py`. A separate module calls the `ArtifactManager` class.';
    assert.deepEqual(detectRelationClaims(answer), []);
});

test('detect: bare filenames with no directory are out of scope (unresolvable)', () => {
    const answer = 'The file `agent.py` calls the `execute` method.';
    assert.deepEqual(detectRelationClaims(answer), []);
});

test('detect: duplicate file+symbol pairs collapse to one claim', () => {
    const answer = [
        '`app/agents/ingest_agent.py` calls the `execute` method.',
        '`app/agents/ingest_agent.py` uses the `execute` method.'
    ].join('\n');
    assert.equal(detectRelationClaims(answer).length, 1);
});

test('detect: list-item-scoped -- file in sentence 1, assertion in sentence 2 (the recall gap)', () => {
    // Verbatim shape of the one claim the clause-local pass alone could not see.
    const answer = [
        '1. **CustomizationInterviewAgent**:',
        '   - The `execute` method in `app/agents/customization_interview_agent.py` handles different actions. Other methods within this class call `self.initialize_session`, which ultimately depend on the `execute` method.'
    ].join('\n');
    const claims = detectRelationClaims(answer);
    assert.ok(
        claims.some(c => c.file === 'app/agents/customization_interview_agent.py' && c.symbol === 'execute'),
        'expected the item-scoped pass to pair the item\'s file with the second-sentence assertion'
    );
});

test('detect: bare "depend on" (plural subject) is matched, not just "depends on"', () => {
    const answer = '1. x\n   - Things in `app/agents/ingest_agent.py` which ultimately depend on the `execute` method.';
    assert.ok(detectRelationClaims(answer).some(c => c.symbol === 'execute'));
});

test('detect: a list item naming TWO files is ambiguous and is skipped, not guessed', () => {
    const answer = [
        '1. **Both**:',
        '   - `app/agents/a.py` and `app/agents/b.py` are involved. Something calls the `execute` method.'
    ].join('\n');
    // Neither file may be paired with the second-sentence assertion.
    const claims = detectRelationClaims(answer);
    assert.deepEqual(claims, [], 'ambiguous multi-file items must yield no claim');
});

// --- code-position analysis ------------------------------------------------

test('strip: removes docstrings, comments and string literals', () => {
    const src = [
        '"""All agents implement the execute() method."""',
        '# We rely on validation inside execute',
        'logger.warning("StoryGenAgent.execute() called on deprecated agent")'
    ].join('\n');
    assert.ok(!/execute/.test(stripCommentsAndStrings(src)), 'no bare mention should survive');
});

test('usesSymbol: a file that only DEFINES the symbol is not a user of it (Class B)', () => {
    // Verbatim shape of all ten falsely-claimed callers in the recorded adv-hot-3 run.
    const src = [
        'class PackagerAgent(BaseAgent):',
        '    async def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:',
        '        return {}'
    ].join('\n');
    assert.equal(usesSymbolInCodePosition(src, 'execute'), false);
});

test('usesSymbol: a log message that LOOKS like a call is not a call (story_gen_agent.py:41)', () => {
    const src = [
        '    def execute(self, inputs):',
        '        logger.warning("StoryGenAgent.execute() called on deprecated agent")'
    ].join('\n');
    assert.equal(usesSymbolInCodePosition(src, 'execute'), false);
});

test('usesSymbol: the real caller IS detected despite docstring noise (base_agent.py:171)', () => {
    const src = [
        '"""All agents inherit from BaseAgent and implement the execute() method."""',
        '    async def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:',
        '        raise NotImplementedError',
        '    async def run(self, inputs):',
        '        output = await self.execute(inputs)'
    ].join('\n');
    assert.equal(usesSymbolInCodePosition(src, 'execute'), true);
});

test('usesSymbol: framework wiring counts as use -- the case that killed the graph-based check', () => {
    // app/main.py:205. The previous symbol-usage check asked the graph, saw no edge, and
    // false-flagged this. Reading the file gets it right.
    const src = [
        'from app.middleware.observability import ObservabilityMiddleware',
        'app.add_middleware(ObservabilityMiddleware)'
    ].join('\n');
    assert.equal(usesSymbolInCodePosition(src, 'ObservabilityMiddleware'), true);
});

test('usesSymbol: absent symbol (Class A)', () => {
    const src = 'def get_current_user(token):\n    return supabase.auth.get_user(token)';
    assert.equal(usesSymbolInCodePosition(src, 'ArtifactManager'), false);
});

// --- end-to-end ------------------------------------------------------------

test('verify: Class B direction inversion is flagged as "defines"', () => {
    const answer = 'The `PackagerAgent` in `app/agents/packager_agent.py` calls the `execute` method.';
    const v = verifyRelationClaims(answer, () => 'class PackagerAgent:\n    async def execute(self, i):\n        return {}');
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, 'defines');
});

test('verify: Class A true absence is flagged as "absent"', () => {
    const answer = 'The router in `app/routers/studio_read.py` uses the `ArtifactManager` class.';
    const v = verifyRelationClaims(answer, () => 'def read_studio():\n    return {}');
    assert.equal(v.length, 1);
    assert.equal(v[0].reason, 'absent');
});

test('verify: a TRUE claim produces no violation', () => {
    const answer = 'The `ExplanationAgent` in `app/agents/explanation_agent.py` uses the `LLMRouter` instance.';
    const v = verifyRelationClaims(answer, () => 'from app.llm_backends.llm_router import LLMRouter\n\nclass ExplanationAgent:\n    def __init__(self, router: LLMRouter):\n        self.router = router');
    assert.deepEqual(v, []);
});

test('verify: an unreadable file yields no violation (only positively-established contradictions)', () => {
    const answer = 'The agent in `app/agents/ghost.py` calls the `execute` method.';
    assert.deepEqual(verifyRelationClaims(answer, () => null), []);
});
