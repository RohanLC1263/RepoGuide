import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves Python's dotted module-path identity (logicalNamespace) and import
 * targets, without a real import-system query -- Python has no embeddable
 * type-checker/import-resolver equivalent to TypeScript's, so this is a
 * best-effort structural resolver, not a guaranteed-correct one. Modeled on
 * the ancestor-walk pattern already proven in
 * src/comprehension/staticAnalyzer.ts's extractImport() (absolute Python import
 * resolution), extended to also cover relative imports (`from . import x`,
 * `from ..pkg import y`), which that function does not handle.
 */
export class PythonModulePathResolver {
    /**
     * Computes the dotted module path for a file (e.g. "httpx._client"), by
     * walking up from the file looking for the outermost ancestor directory
     * chain of `__init__.py` files, then joining the relative path with dots.
     * Falls back to a workspace-relative path-as-namespace (still dot-joined)
     * when no `__init__.py` is found anywhere in the chain -- an honest
     * best-effort label for namespace packages / flat script repos, not a
     * resolved identity (see `modulePathIsAuthoritative`).
     */
    public static resolveModulePath(filePath: string, workspaceRoot: string): { modulePath: string; isAuthoritative: boolean } {
        const packageRoot = this.findPackageRoot(filePath);
        const root = packageRoot ?? workspaceRoot;
        const isAuthoritative = packageRoot !== null;

        let rel = path.relative(root, filePath).split(path.sep).join('/');
        if (rel.endsWith('.py')) {
            rel = rel.slice(0, -3);
        }
        const segments = rel.split('/').filter(Boolean);
        if (segments.length > 0 && segments[segments.length - 1] === '__init__') {
            segments.pop();
        }
        return { modulePath: segments.join('.'), isAuthoritative };
    }

    /**
     * Walks up from `filePath`'s directory while each successive parent
     * directory still contains an `__init__.py`, to find the top of the
     * package tree. Returns the directory ABOVE the outermost `__init__.py`
     * (i.e. the root such that `path.relative(root, filePath)` gives the
     * correct dotted path), or null if `filePath`'s own directory has no
     * `__init__.py` at all (not part of any package).
     */
    private static findPackageRoot(filePath: string): string | null {
        let dir = path.dirname(filePath);
        if (!fs.existsSync(path.join(dir, '__init__.py'))) {
            return null;
        }
        let root = dir;
        for (;;) {
            const parent = path.dirname(dir);
            if (parent === dir) {
                break; // reached filesystem root
            }
            if (!fs.existsSync(path.join(parent, '__init__.py'))) {
                break;
            }
            dir = parent;
            root = parent;
        }
        return path.dirname(root);
    }

    /**
     * Resolves a relative import (`from . import x` / `from ..pkg import y`)
     * to a file path. `dotCount` is the number of leading dots (1 = current
     * package), `trailingModule` is the remaining dotted segment after the
     * dots, if any (e.g. "pkg" in "from ..pkg import y"), and `importingFile`
     * is the file containing the import statement.
     */
    public static resolveRelativeImport(importingFile: string, dotCount: number, trailingModule: string | null): string | null {
        // One dot means "this file's own package directory"; each additional
        // dot walks up one more package level.
        let dir = path.dirname(importingFile);
        for (let i = 1; i < dotCount; i++) {
            dir = path.dirname(dir);
        }
        if (trailingModule) {
            const parts = trailingModule.split('.');
            const candidate1 = path.join(dir, ...parts) + '.py';
            const candidate2 = path.join(dir, ...parts, '__init__.py');
            if (fs.existsSync(candidate1)) return candidate1;
            if (fs.existsSync(candidate2)) return candidate2;
            return null;
        }
        const initCandidate = path.join(dir, '__init__.py');
        return fs.existsSync(initCandidate) ? initCandidate : null;
    }

    /**
     * Resolves an absolute Python import ("app.agents.base_agent") to a file
     * path, searching the workspace root and ancestor directories of the
     * importing file that plausibly contain the first module segment --
     * the same search strategy already proven in staticAnalyzer.ts.
     */
    public static resolveAbsoluteImport(importingFile: string, workspaceRoot: string, dottedModule: string): string | null {
        const moduleParts = dottedModule.split('.');
        const firstPart = moduleParts[0];
        const searchRoots: string[] = [workspaceRoot];

        let dir = path.dirname(importingFile);
        const normalizedRoot = path.normalize(workspaceRoot).toLowerCase();
        while (dir.toLowerCase().startsWith(normalizedRoot) && dir.length > normalizedRoot.length) {
            const parentDir = path.dirname(dir);
            if (fs.existsSync(path.join(parentDir, firstPart)) || fs.existsSync(path.join(parentDir, firstPart + '.py'))) {
                if (!searchRoots.includes(parentDir)) {
                    searchRoots.push(parentDir);
                }
            }
            dir = parentDir;
        }

        for (const root of searchRoots) {
            for (let len = moduleParts.length; len >= 1; len--) {
                const subPath = moduleParts.slice(0, len).join(path.sep);
                const fileCandidate = path.join(root, subPath + '.py');
                const initCandidate = path.join(root, subPath, '__init__.py');
                if (fs.existsSync(fileCandidate)) return fileCandidate;
                if (fs.existsSync(initCandidate)) return initCandidate;
            }
        }
        return null;
    }
}
