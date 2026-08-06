import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { isWithinWorkspace } from '../../security/pathSafety';

// P1-1 (STRICT_AUDIT_2026-08-04): `answerGate.ts`'s `readFileFresh` read any absolute or
// `../`-escaping path a claimed citation resolved to, with no containment check at all.
// These pin the shared helper's own correctness; `answerGate.readFileFreshContainment.test.ts`
// pins that the gate actually calls it.

test('isWithinWorkspace: a file directly inside the workspace is within it', () => {
    assert.equal(isWithinWorkspace('/repo/src/index.ts', '/repo'), true);
});

test('isWithinWorkspace: a file several directories deep is within it', () => {
    assert.equal(isWithinWorkspace('/repo/a/b/c/deep.ts', '/repo'), true);
});

test('isWithinWorkspace: the workspace root itself is within it', () => {
    assert.equal(isWithinWorkspace('/repo', '/repo'), true);
});

test('isWithinWorkspace: a `..`-escaping relative path is rejected', () => {
    assert.equal(isWithinWorkspace('/repo/../etc/passwd', '/repo'), false);
    assert.equal(isWithinWorkspace(path.join('/repo', '..', '..', 'etc', 'passwd'), '/repo'), false);
});

test('isWithinWorkspace: an unrelated absolute path is rejected', () => {
    assert.equal(isWithinWorkspace('/etc/passwd', '/repo'), false);
    assert.equal(isWithinWorkspace('C:\\Windows\\System32\\config\\SAM', '/repo'), false);
});

test('isWithinWorkspace: a sibling directory that merely shares a string prefix is rejected', () => {
    // The classic false-positive of this check class: a naive `fsPath.startsWith(workspaceRoot)`
    // would wrongly accept this, since '/repo-other/file' starts with '/repo'.
    assert.equal(isWithinWorkspace('/repo-other/file.ts', '/repo'), false);
    assert.equal(isWithinWorkspace('/repobar/file.ts', '/repo'), false);
});

test('isWithinWorkspace: a relative fsPath is resolved against cwd, not silently accepted', () => {
    // path.relative() resolves both arguments before comparing, so a relative fsPath is
    // evaluated against its real resolved location -- not exempted from the check.
    const outside = path.resolve('..', '__pathSafety_probe__');
    assert.equal(isWithinWorkspace(outside, process.cwd()), false);
});
