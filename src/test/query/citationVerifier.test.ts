import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyCitedSymbolClaims, extractCitedSymbolClaims } from '../../query/citationVerifier';

/**
 * Claim-listing makes the model attach a citation to every claim, but the local model
 * treats SUPPORT as a LOOKUP rather than a VERIFICATION -- measured: ~20 real file:line
 * citations attached to a claim about a symbol appearing zero times in the cited file.
 * These tests pin the mechanical check that catches exactly that.
 */

function tmpRepo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-cite-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return dir;
}
const read = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

test('catches a claim whose cited file does not contain the symbol (the measured failure)', () => {
    const repo = tmpRepo({
        'app/agents/customization_interview_agent.py': 'class CustomizationInterviewAgent:\n    confidence_threshold = 0.55\n'
    });
    const answer = 'The apply_decision_policy function is used by app/agents/customization_interview_agent.py to gate answers.';
    const v = verifyCitedSymbolClaims(answer, repo, read);
    assert.ok(v.some(x => x.symbol === 'apply_decision_policy'), 'must flag the unsupported citation');
    fs.rmSync(repo, { recursive: true, force: true });
});

test('does NOT flag a claim whose cited file really does contain the symbol', () => {
    const repo = tmpRepo({
        'craft_classifier_agent/agent.py': 'from .decision_policy import apply_decision_policy\n\ndecision = apply_decision_policy(x)\n'
    });
    const answer = 'apply_decision_policy is called from craft_classifier_agent/agent.py during classification.';
    assert.deepEqual(verifyCitedSymbolClaims(answer, repo, read), []);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('does NOT flag a path fragment as a missing symbol (real false positive that was fixed)', () => {
    // "craft_classifier_agent" is a DIRECTORY in the cited path, not a symbol claimed to
    // live inside decision_policy.py. Before the path-fragment guard this was reported.
    const repo = tmpRepo({ 'craft_classifier_agent/decision_policy.py': 'REJECT_THRESHOLD = 0.40\n' });
    const answer = 'The threshold lives in craft_classifier_agent/decision_policy.py.';
    assert.deepEqual(verifyCitedSymbolClaims(answer, repo, read), []);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('an unresolvable file path yields NO violation -- the check can only report a provably wrong citation', () => {
    const repo = tmpRepo({ 'real.py': 'x = 1\n' });
    const answer = 'SomeSymbol is defined in app/does/not/exist.py.';
    assert.deepEqual(verifyCitedSymbolClaims(answer, repo, read), []);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('no workspace root -> inert (backward compatible)', () => {
    const answer = 'SomeSymbol is defined in app/whatever.py.';
    assert.deepEqual(verifyCitedSymbolClaims(answer, undefined, read), []);
});

test('prose nouns are not treated as symbols', () => {
    // Only CamelCase / snake_case shapes qualify; plain words must never be verified.
    const claims = extractCitedSymbolClaims('The mission and the request are handled in app/main.py.');
    assert.ok(!claims.some(c => c.symbol === 'mission' || c.symbol === 'request'));
});

test('framework/common nouns are stoplisted', () => {
    const repo = tmpRepo({ 'app/main.py': 'app = FastAPI()\n' });
    const answer = 'The JSON payload and HTTP request are parsed in app/main.py.';
    const v = verifyCitedSymbolClaims(answer, repo, read);
    assert.ok(!v.some(x => ['JSON', 'HTTP'].includes(x.symbol)));
    fs.rmSync(repo, { recursive: true, force: true });
});

// --- Phase 4: list-structured claims bound by anaphora, not proximity ----------

test('catches invented helper names introduced far from the filename that governs them', () => {
    // The measured pdf_generator.py case: five invented helpers (`_truncate`,
    // `_safe_list`, `_get_title`, `_get_description`, `_get_materials`) introduced with
    // "The file contains several helper functions like ...", 1,444 characters after the
    // filename -- far outside CLAIM_WINDOW, so pure proximity never formed the pair.
    const repo = tmpRepo({
        'app/services/pdf_generator.py': 'def _register_fonts():\n    pass\n\ndef fmt_craft(raw):\n    pass\n'
    });
    const answer = [
        'The `pdf_generator.py` file generates artisan reports using ReportLab.',
        '',
        '### External Dependencies',
        '',
        'It registers fonts via `_register_fonts` and lays out pages with a canvas object. '
        + 'A lot of prose sits here to push the helper list well outside the proximity window. '.repeat(12),
        '',
        '### Internal Dependencies',
        '',
        '1. **Helper Functions**:',
        '   - The file contains several helper functions like `_truncate`, `_safe_list` and `_get_title`.'
    ].join('\n');
    const violations = verifyCitedSymbolClaims(answer, repo, read, ['app/services/pdf_generator.py']);
    const flagged = violations.map(v => v.symbol);
    for (const invented of ['_truncate', '_safe_list', '_get_title']) {
        assert.ok(flagged.includes(invented), `${invented} is invented and must be flagged`);
    }
    assert.ok(!flagged.includes('_register_fonts'), 'a real helper must not be flagged');
    fs.rmSync(repo, { recursive: true, force: true });
});

test('a bare filename resolves against the packet when unambiguous, and not otherwise', () => {
    const repo = tmpRepo({ 'app/services/pdf_generator.py': 'def real_one():\n    pass\n' });
    const answer = 'The `pdf_generator.py` file exposes `_totally_invented` for callers.';
    assert.equal(
        verifyCitedSymbolClaims(answer, repo, read, []).length, 0,
        'with nothing to resolve against, an unresolvable bare name must stay unchecked'
    );
    assert.equal(
        verifyCitedSymbolClaims(answer, repo, read, ['app/services/pdf_generator.py', 'legacy/pdf_generator.py']).length, 0,
        'an ambiguous basename must not be guessed'
    );
    assert.equal(
        verifyCitedSymbolClaims(answer, repo, read, ['app/services/pdf_generator.py'])[0]?.symbol,
        '_totally_invented'
    );
    fs.rmSync(repo, { recursive: true, force: true });
});

// --- Phase 5: no cross-pairing between adjacent claims -------------------------

test('does NOT pair a name from an intro list with the citation of a later section (real FP)', () => {
    // Measured false positive: "The `MissionOrchestratorAgent`, `MissionCoordinator`, and
    // `OrchestratorAgent` classes serve distinct purposes" followed by a section header
    // citing mission_orchestrator.py for the FIRST of them. `OrchestratorAgent` sat 155
    // chars from that citation and was reported unsupported -- but it is a real class in
    // orchestrator_agent.py and the answer never claimed it lived elsewhere.
    const repo = tmpRepo({
        'app/agents/mission_orchestrator.py': 'class MissionOrchestratorAgent:\n    pass\n',
        'app/agents/orchestrator_agent.py': 'class OrchestratorAgent:\n    pass\n'
    });
    const answer = [
        'The `MissionOrchestratorAgent`, `MissionCoordinator`, and `OrchestratorAgent` classes serve distinct purposes.',
        '',
        '### 1. **MissionOrchestratorAgent**',
        '- **File**: `app/agents/mission_orchestrator.py`',
        '- **Role**: orchestrates mission phases.'
    ].join('\n');
    const flagged = verifyCitedSymbolClaims(answer, repo, read).map(v => v.symbol);
    assert.ok(!flagged.includes('OrchestratorAgent'), 'must not invent a claim the answer never made');
    assert.ok(!flagged.includes('MissionCoordinator'), 'same for the second name in the list');
    fs.rmSync(repo, { recursive: true, force: true });
});

test('still catches a genuine misattribution inside a section', () => {
    const repo = tmpRepo({ 'app/routers/studio_write.py': '@router.post("/api/mission/{mission_id}/seal")\ndef seal(...):\n    pass\n' });
    const answer = 'The endpoint is handled by the `create_sealed_mission` function in `app/routers/studio_write.py`.';
    const flagged = verifyCitedSymbolClaims(answer, repo, read).map(v => v.symbol);
    assert.ok(flagged.includes('create_sealed_mission'), 'a nonexistent function must still be caught');
    fs.rmSync(repo, { recursive: true, force: true });
});
