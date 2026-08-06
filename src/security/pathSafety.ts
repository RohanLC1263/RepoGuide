import * as path from 'path';

/**
 * True when `fsPath` resolves to a location inside `workspaceRoot` (including the root
 * itself). `path.relative` resolves both arguments to absolute paths before comparing, so
 * this is safe against `..` segments and mixed separators on either side -- and against the
 * classic false-positive of this check class, a workspace root that is a string PREFIX of an
 * unrelated sibling directory (`workspaceRoot=/foo/bar`, `fsPath=/foo/barbaz/file` must be
 * `false`, not `true` -- a naive `fsPath.startsWith(workspaceRoot)` gets this wrong).
 *
 * Was duplicated byte-for-byte in `comprehension/fileChangeHandler.ts` and
 * `comprehension/fileLifecycleHandler.ts`; consolidated here (P1-1) so the containment logic
 * has exactly one definition to audit, and so `answerGate.ts`'s `readFileFresh` -- which had
 * NO containment check at all, reading any absolute or `../`-escaping path an answer cited --
 * can reuse it rather than growing a third copy.
 */
export function isWithinWorkspace(fsPath: string, workspaceRoot: string): boolean {
    const relative = path.relative(workspaceRoot, fsPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
