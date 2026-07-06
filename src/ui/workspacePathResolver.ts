import * as fs from 'fs';
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
 *
 * On non-Windows platforms, if the naively-resolved path doesn't exist,
 * falls back to a case-insensitive directory walk to find the real file --
 * defense-in-depth for citations built with the wrong casing (see
 * HALLUCINATION_INVESTIGATION_REPORT.md for the real, now-fixed ingestion
 * bug this was originally insurance against). Windows doesn't need this;
 * its filesystem already resolves case-insensitively.
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

    if (process.platform !== 'win32' && !fs.existsSync(resolvedTarget)) {
        const caseInsensitiveMatch = findCaseInsensitiveMatch(resolvedRoot, relative);
        if (caseInsensitiveMatch) {
            return caseInsensitiveMatch;
        }
    }

    return resolvedTarget;
}

/**
 * Walks down from `root` one path segment at a time, matching each segment
 * case-insensitively against the real directory entries, so a citation like
 * `app-header-component for craftconnect/app/layout.tsx` still resolves to
 * the real `.../CraftConnect/...` file on a case-sensitive filesystem.
 * Returns null (never guesses) if any segment along the way has no
 * case-insensitive match.
 */
export function findCaseInsensitiveMatch(root: string, relativePath: string): string | null {
    const segments = relativePath.split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of segments) {
        let entries: string[];
        try {
            entries = fs.readdirSync(current);
        } catch {
            return null;
        }
        const match = entries.find(entry => entry.toLowerCase() === segment.toLowerCase());
        if (!match) {
            return null;
        }
        current = path.join(current, match);
    }
    try {
        fs.accessSync(current);
    } catch {
        return null;
    }
    return current;
}
