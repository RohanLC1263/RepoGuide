import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves Go's module-path-based identity and import targets. Go's own
 * `package` clause is a bare identifier with no resolvable path at all --
 * unlike Java's package or C#'s namespace, it cannot be used the same way.
 * The real resolvable identity comes from combining the module's declared
 * path (the `module` directive in go.mod, a simple line-based format, not
 * Go source -- not parsed via tree-sitter) with the file's directory
 * position relative to the module root. Go import paths always refer to a
 * package (a directory), never a single file -- unlike Java/C#, where an
 * import can resolve to one specific class file.
 */
export class GoModuleResolver {
    /**
     * Walks up from `filePath`'s directory looking for the nearest go.mod,
     * and returns the module root directory and its declared module path.
     * Returns a best-effort fallback (the file's own directory as root, ''
     * as module path) if no go.mod is found anywhere above it.
     */
    public static findModule(filePath: string): { moduleRoot: string; modulePath: string } {
        let dir = path.dirname(filePath);
        for (;;) {
            const goModPath = path.join(dir, 'go.mod');
            if (fs.existsSync(goModPath)) {
                const modulePath = this.parseModulePath(fs.readFileSync(goModPath, 'utf8'));
                if (modulePath) {
                    return { moduleRoot: dir, modulePath };
                }
                return { moduleRoot: dir, modulePath: '' };
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break; // reached filesystem root
            }
            dir = parent;
        }
        return { moduleRoot: path.dirname(filePath), modulePath: '' };
    }

    private static parseModulePath(goModContent: string): string | null {
        const match = goModContent.match(/^module\s+(\S+)/m);
        return match ? match[1] : null;
    }

    /** Computes this file's own resolvable import path: modulePath + its directory's relative position under moduleRoot, joined with '/' (Go import paths always use forward slashes, regardless of OS). */
    public static computeImportPath(filePath: string, moduleRoot: string, modulePath: string): string {
        if (!modulePath) {
            return path.basename(path.dirname(filePath)); // best-effort fallback, not authoritative
        }
        const relDir = path.relative(moduleRoot, path.dirname(filePath)).split(path.sep).filter(Boolean).join('/');
        return relDir ? `${modulePath}/${relDir}` : modulePath;
    }

    /**
     * Resolves an import path (e.g. "resty.dev/v3/internal/util") to a real
     * directory under `moduleRoot`, only if it's within this module (prefixed
     * by `modulePath`). Everything else -- stdlib ("net/http"), third-party
     * modules -- is out of scope and correctly unresolved, same tier as an
     * external/BCL import in the other providers.
     */
    public static resolveImport(importPath: string, moduleRoot: string, modulePath: string): string | null {
        if (!modulePath || importPath !== modulePath && !importPath.startsWith(`${modulePath}/`)) {
            return null;
        }
        const relPath = importPath === modulePath ? '' : importPath.slice(modulePath.length + 1);
        const candidate = relPath ? path.join(moduleRoot, ...relPath.split('/')) : moduleRoot;
        return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
    }
}
