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
