import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnswerGate } from '../../query/answerGate';
import { EvidencePacket } from '../../query/evidencePacket';
import { EvidencePlan } from '../../query/evidencePlanTypes';

// P1-1 (STRICT_AUDIT_2026-08-04): `readFileFresh` inside `AnswerGate.verify()` read whatever
// path a citation in the ANSWER resolved to, with no check that it stayed inside the
// workspace. `verifyRelationClaims` (relationClaimVerifier.ts) resolves a claim's file with
// `path.resolve(workspaceRoot, claim.file)`, so a claim naming `../secret.py` escaped the
// workspace entirely -- and because `AnswerGate` is on the real query/MCP path
// (`queryDispatcher.ts` always passes the real `workspaceRoot`), any answer that happened to
// name a `../`-shaped path got that path's REAL, off-workspace file content read into the
// gate's verification logic.
//
// This test proves the escape is closed by observing its actual effect end-to-end, not just
// calling the path helper in isolation (see pathSafety.test.ts for that): a file placed
// OUTSIDE the workspace, containing only a bare `def execute(): pass` (a definition, not a
// use), makes `verifyRelationClaims` flag a violation ('defines') if it is successfully read,
// and report nothing (silently treats the citation as unverifiable, same as a missing file)
// if the read is blocked. That is an observable behavioural difference, not just an internal
// assertion, and it flows through the exact same closure every real citation check shares.

function basePlan(): EvidencePlan {
    return {
        originalQuery: 'q', normalizedQuery: 'q', queryType: 'behavior_explanation' as any,
        requiredEvidence: [], symbolHints: [], fileHints: [], phrases: [], factTypes: [],
        unitTypes: [], fileScope: 'implementation_only' as any, retrievalStrategy: 'default' as any,
        mustExcludeRoles: [], diagnostics: [], confidence_mode: 'grounded'
    } as EvidencePlan;
}

function packet(claimedFile: string): EvidencePacket {
    // The claimed file is included as an evidence item so the SEPARATE path-attribution check
    // (6b-adjacent -- "the answer cites a path that isn't even in the evidence packet") is
    // satisfied and doesn't block first, the same pattern answerGateFileUsage.test.ts uses to
    // isolate its own check. Padded to THIN_GROUNDING_MIN_SOURCES so check 6d doesn't also fire.
    const items = [
        { id: 'it0', file: claimedFile, startLine: 1, endLine: 1, role: 'implementation' as any,
            type: 'file', content: 'padding content', retrieval_signal: 'lance_store',
            score: 0.9, confidence: 1, extractionMethod: 'tree_sitter' as any },
        ...Array.from({ length: 2 }, (_, i) => ({
            id: 'pad' + i, file: 'app/other.py', startLine: 1, endLine: 1, role: 'implementation' as any,
            type: 'file', content: 'padding content', retrieval_signal: 'lance_store',
            score: 0.9, confidence: 1, extractionMethod: 'tree_sitter' as any
        }))
    ];
    return { query: 'q', plan: basePlan(), items: items as any, facts: [], coverage: [], gaps: [], diagnostics: [], coverageScore: 0, matchedEvidenceTypes: [] };
}

test('AnswerGate.verify: a relation claim citing a `../`-escaping path cannot read outside the workspace', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-p1-1-'));
    const workspaceRoot = path.join(tmpRoot, 'ws');
    fs.mkdirSync(workspaceRoot, { recursive: true });

    // Placed as a SIBLING of the workspace, not inside it -- `../secret.py` from workspaceRoot
    // resolves exactly here.
    const secretFile = path.join(tmpRoot, 'secret.py');
    fs.writeFileSync(secretFile, 'def execute():\n    return leak()\n', 'utf8');

    const answer = 'The `../secret.py` file calls the `execute` method to package content.';
    const gate = new AnswerGate();

    const result = gate.verify(answer, packet('../secret.py'), undefined, workspaceRoot);

    // Pre-fix, `readFileFresh` would successfully read `secretFile`'s real content, find
    // `execute` present only as its own definition, and `verifyRelationClaims` would push a
    // "the source contradicts this" violation grounded in a file that was never part of this
    // repository. Post-fix, the read is refused, `verifyRelationClaims` sees `source === null`,
    // and the claim is silently treated as unverifiable -- identical to citing a file that
    // simply does not exist. Asserted on relationClaimVerifier's own message shape
    // (`answerGate.ts`'s check 6c), not a generic "mentions the filename" check, since other,
    // unrelated checks may legitimately mention the same string.
    assert.equal(
        result.unsupported_claims.some(c => /asserts a dependency that the source contradicts/.test(c)),
        false,
        'the out-of-workspace file content must never ground a relation-claim violation'
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('AnswerGate.verify: a citation to a real in-workspace file over the size cap is not read', () => {
    // Second half of P1-1: an in-workspace file is not exempt from abuse just because it's
    // inside the boundary -- a huge file (lockfile, bundle, stray binary) must not be read
    // wholesale just to check a short claim against it.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-p1-1-size-'));
    const workspaceRoot = path.join(tmpRoot, 'ws');
    const agentDir = path.join(workspaceRoot, 'app', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    // 3 MB of filler, `execute` present ONLY as its own definition (a genuine 'defines'
    // violation shape -- same as the traversal test above). If the cap did NOT apply, this
    // file would be read in full and correctly flagged. If the cap applies and the file is
    // skipped, `source === null` and NOTHING is flagged -- a false negative in isolation, but
    // the point being tested here is specifically that the cap fires, not that oversized
    // citations are ideally handled (that would need a "file too large to verify" caveat,
    // out of scope for this fix).
    const oversized = 'x'.repeat(3 * 1024 * 1024) + '\ndef execute():\n    pass\n';
    fs.writeFileSync(path.join(agentDir, 'huge_agent.py'), oversized, 'utf8');

    const answer = 'The `app/agents/huge_agent.py` file calls the `execute` method to run the task.';
    const gate = new AnswerGate();
    const result = gate.verify(answer, packet('app/agents/huge_agent.py'), undefined, workspaceRoot);

    assert.equal(
        result.unsupported_claims.some(c => /asserts a dependency that the source contradicts/.test(c)),
        false,
        'an oversized file must be silently skipped (cap fired), not read in full and flagged'
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('AnswerGate.verify: the identical claim shape against a REAL in-workspace file still verifies normally', () => {
    // Control: the fix must not make every relation claim unverifiable -- only ones that
    // escape the workspace.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-p1-1-control-'));
    const workspaceRoot = path.join(tmpRoot, 'ws');
    const agentDir = path.join(workspaceRoot, 'app', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
        path.join(agentDir, 'real_agent.py'),
        'def run():\n    return execute()\n\ndef execute():\n    return True\n',
        'utf8'
    );

    const answer = 'The `app/agents/real_agent.py` file calls the `execute` method to run the task.';
    const gate = new AnswerGate();
    const result = gate.verify(answer, packet('app/agents/real_agent.py'), undefined, workspaceRoot);

    // `execute` genuinely appears in a real (non-definition) call position in this file, so
    // this must NOT be flagged -- a real, in-workspace citation is unaffected by the guard.
    assert.equal(
        result.unsupported_claims.some(c => /asserts a dependency that the source contradicts/.test(c)),
        false
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
});
