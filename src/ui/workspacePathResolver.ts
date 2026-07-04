import * as path from 'path';

/**
 * Resolves a citation/note/brief-supplied file path against the workspace
 * root, refusing to honor any path (relative, or already-absolute) that
 * resolves outside the workspace boundary. These paths ultimately originate
 * from indexed repository content flowing through an LLM answer into a
 * webview's postMessage payload -- a malicious repository could embed a
 * path designed to make RepoGuide open an arbitrary local file (e.g. an SSH
 * key or credentials file) once a user clicks the resulting citation
 * button. Returns null when the path escapes the workspace, rather than
 * silently clamping it to something plausible-looking.
 */
export function resolveWorkspaceFilePath(filePath: string, workspaceRoot: string): string | null {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedTarget = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(resolvedRoot, filePath);

    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
    }
    return resolvedTarget;
}
