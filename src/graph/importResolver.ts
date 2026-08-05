/**
 * Resolves an import statement to the repository file(s) it actually refers to.
 *
 * WHY THIS EXISTS. `ProgramGraphBuilder` previously resolved import edges by scanning file
 * nodes in arbitrary insertion order and linking to the FIRST one whose basename appeared
 * anywhere in the import text, then breaking. Two measured consequences on CraftConnect
 * (2026-08-04):
 *
 *  1. PACKAGE FILES WERE UNREACHABLE. A package's basename is `__init__`, and the string
 *     "__init__" never appears in `from app.agents import MissionOrchestratorAgent`. So no
 *     import edge could ever point at an `__init__.py`. `app/agents/__init__.py` has 68 real
 *     importers by Python's own semantics and the graph reported ZERO -- which then reads as
 *     "nothing imports this file", the exact signal the dead-file caveat keys on.
 *
 *  2. SUBSTRING MATCHING PRODUCED WRONG EDGES. `from . import auth` matched
 *     `app/core/auth.py` purely because "auth" occurs in the text, regardless of which
 *     directory the importing file actually sits in. Short basenames (`db.py`, `api.py`) match
 *     a large share of unrelated imports.
 *
 * This resolver replaces the substring guess with real module-path resolution: dotted Python
 * paths and relative TS/JS specifiers are mapped to concrete candidate file paths, and only an
 * EXACT hit against a known file becomes an edge.
 *
 * DIRECTION OF ERROR: unresolvable imports return no targets rather than a guess. An external
 * dependency (`import numpy`) has no file in the repository and must produce no edge at all --
 * inventing one would be worse than the missing edge it replaces.
 */

/** A parsed import statement, before it is mapped onto the filesystem. */
export interface ParsedImport {
    /** Dotted module path as written (`app.agents.mission_orchestrator`), '' for `from . import x`. */
    module: string;
    /** Names in the `import a, b` clause -- each may itself be a submodule. */
    names: string[];
    /** Leading-dot count for Python relative imports; 0 for absolute. */
    relativeLevel: number;
    /** True when the specifier was a TS/JS path string rather than a dotted module. */
    isPathSpecifier: boolean;
}

const PY_FROM = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+([^\n#]+)/m;
const PY_IMPORT = /^\s*import\s+([A-Za-z_][\w.]*)/m;
const JS_FROM = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/;

/** Parses a Python or TS/JS import statement. Returns null when nothing importable is found. */
export function parseImportStatement(importText: string): ParsedImport | null {
    const js = JS_FROM.exec(importText);
    if (js) {
        return { module: js[1], names: [], relativeLevel: 0, isPathSpecifier: true };
    }
    const from = PY_FROM.exec(importText);
    if (from) {
        const dots = from[1] ?? '';
        const names = (from[3] ?? '')
            .replace(/[()]/g, '')
            .split(',')
            .map(n => n.trim().split(/\s+as\s+/)[0].trim())
            .filter(n => n.length > 0 && n !== '*');
        return { module: from[2] ?? '', names, relativeLevel: dots.length, isPathSpecifier: false };
    }
    const plain = PY_IMPORT.exec(importText);
    if (plain) {
        return { module: plain[1], names: [], relativeLevel: 0, isPathSpecifier: false };
    }
    return null;
}

/** Directory portion of a repo-relative file path ('' for a root-level file). */
function dirOf(filePath: string): string {
    const i = filePath.lastIndexOf('/');
    return i < 0 ? '' : filePath.slice(0, i);
}

/** Applies `levels` of upward traversal to a directory path. */
function ascend(dir: string, levels: number): string | null {
    let parts = dir.length > 0 ? dir.split('/') : [];
    for (let i = 0; i < levels; i++) {
        if (parts.length === 0) {
            return null;
        }
        parts = parts.slice(0, -1);
    }
    return parts.join('/');
}

const PY_EXTENSIONS = ['.py'];
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Candidate file paths a module path could denote, in priority order: the module file itself,
 * then the package's `__init__` / `index` file.
 */
function candidatesFor(basePath: string, isPathSpecifier: boolean): string[] {
    const exts = isPathSpecifier ? JS_EXTENSIONS : PY_EXTENSIONS;
    const out: string[] = [];
    for (const ext of exts) {
        out.push(`${basePath}${ext}`);
    }
    for (const ext of exts) {
        out.push(isPathSpecifier ? `${basePath}/index${ext}` : `${basePath}/__init__${ext}`);
    }
    return out;
}

/**
 * Resolves `importText` (appearing in `sourceFilePath`) to repo-relative file paths.
 *
 * `fileExists` is asked about exact repo-relative paths only. Returns [] when nothing resolves,
 * which is the correct outcome for third-party and stdlib imports.
 *
 * A `from <pkg> import a, b` statement resolves to the package file AND to any of `a`/`b` that
 * are themselves modules in that package -- both are genuine reachability edges, and the
 * package `__init__` is the one the old matcher could never see.
 */
export function resolveImportToFiles(
    importText: string,
    sourceFilePath: string,
    fileExists: (repoRelativePath: string) => boolean
): string[] {
    const parsed = parseImportStatement(importText);
    if (!parsed) {
        return [];
    }
    const normalizedSource = sourceFilePath.replace(/\\/g, '/');
    const resolved = new Set<string>();

    let base: string | null;
    if (parsed.isPathSpecifier) {
        if (!parsed.module.startsWith('.')) {
            return []; // bare package specifier ('react') -- not a repo file
        }
        const dir = dirOf(normalizedSource);
        const cleaned = parsed.module.replace(/^\.\//, '');
        const up = (cleaned.match(/^(\.\.\/)+/)?.[0].length ?? 0) / 3;
        const tail = cleaned.replace(/^(\.\.\/)+/, '');
        const from = ascend(dir, up);
        base = from === null ? null : (from.length > 0 ? `${from}/${tail}` : tail);
    } else if (parsed.relativeLevel > 0) {
        // `from . import x` is level 1 and means THIS package, so ascend level-1 directories.
        const from = ascend(dirOf(normalizedSource), parsed.relativeLevel - 1);
        if (from === null) {
            return [];
        }
        const modPath = parsed.module.length > 0 ? parsed.module.split('.').join('/') : '';
        base = modPath.length > 0 ? (from.length > 0 ? `${from}/${modPath}` : modPath) : from;
    } else {
        base = parsed.module.split('.').join('/');
    }

    if (base === null || base.length === 0) {
        return [];
    }

    for (const candidate of candidatesFor(base, parsed.isPathSpecifier)) {
        if (fileExists(candidate)) {
            resolved.add(candidate);
            break; // module file wins over package file for the same base
        }
    }

    // `from pkg import submodule` -- the imported NAME may itself be a module in that package.
    if (!parsed.isPathSpecifier) {
        for (const name of parsed.names) {
            for (const candidate of candidatesFor(`${base}/${name}`, false)) {
                if (fileExists(candidate)) {
                    resolved.add(candidate);
                    break;
                }
            }
        }
    }

    return [...resolved];
}
