import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';

const DEFAULT_IGNORES = [
    'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
    '.repoguide', '.venv', 'venv', 'env', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next',
    '.turbo', 'target', 'local_models', '_local_models',
    'artifacts', 'logs', '*.min.js', '*.map', '*.lock',
    'package-lock.json',
    // Additional exclusions for messy real-world repos
    '_archive', 'archive', 'backup', 'backups',
    'migrations', 'temp', 'tmp', 'scratch',
    '*.backup.py', '*.backup.ts', '*.bak',
    'debug_*', 'manual_*', 'test_*'
];

export const ALLOWED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.kt', '.rb', '.cs', '.php', '.swift', '.md',
    // Infra/deployment config: previously entirely unindexed (confirmed empirically
    // -- CraftConnect's real Dockerfile and deployment/cloud_run_config.yaml had
    // zero manifest entries), so a question like "does this deploy to Kubernetes"
    // could only ever get an honest-but-uninformative "evidence does not
    // determine", never a real answer, no matter how good retrieval got. .yaml/.yml
    // covers Kubernetes manifests, docker-compose, and CI configs (e.g.
    // .github/workflows/*.yml) with one entry, since none of those use a dedicated
    // extension of their own.
    '.yaml', '.yml'
]);

/** Basenames (case-insensitive) that carry real infra/deployment/build meaning
 * but have no extension at all for ALLOWED_EXTENSIONS to match -- "Dockerfile"
 * and "Makefile" are bare filenames by convention. */
const ALLOWED_INFRA_BASENAMES = new Set(['dockerfile', 'makefile', '.env']);
/** Basename prefixes for infra file family members path.extname() would
 * otherwise misclassify: "Dockerfile.dev" has extname ".dev"; ".env.example"/
 * ".env.production" have extname ".example"/".production" -- neither looks
 * like a real extension, so these need prefix matching instead. */
const ALLOWED_INFRA_BASENAME_PREFIXES = ['dockerfile.', '.env.'];

export const DEFAULT_MAX_FILES = 2000;

// Filename conventions (extension stripped) that usually mark an entry point --
// prioritized when a budget forces truncation, since they're disproportionately
// useful for understanding a codebase relative to their count.
const ENTRY_POINT_BASENAMES = new Set([
    'index', 'main', 'cli', 'app', 'server', 'extension'
]);

export interface WalkResult {
    filePaths: string[];
    truncated: boolean;
    totalDiscovered: number;
}

function isEntryPointBasename(filePath: string): boolean {
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    return ENTRY_POINT_BASENAMES.has(base);
}

/**
 * Merges DEFAULT_IGNORES with user-configured exclude patterns.
 */
export function getAllIgnorePatterns(userPatterns: string[] = []): string[] {
    const merged = [...DEFAULT_IGNORES];
    for (const p of userPatterns) {
        if (p && !merged.includes(p)) {
            merged.push(p);
        }
    }
    return merged;
}

/**
 * Returns true if the given file path has an allowed extension for indexing,
 * or is one of the known extension-less infra/deployment file conventions
 * (Dockerfile, Makefile, .env and its variants).
 */
export function isWalkableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
        return true;
    }
    const base = path.basename(filePath).toLowerCase();
    if (ALLOWED_INFRA_BASENAMES.has(base)) {
        return true;
    }
    return ALLOWED_INFRA_BASENAME_PREFIXES.some(prefix => base.startsWith(prefix));
}

/**
 * Returns true if the file path matches an ignored pattern.
 * Checks both DEFAULT_IGNORES and user-configured repoguide.excludePatterns.
 * Handles both directory-style patterns (e.g. "vendor") and glob-style
 * patterns (e.g. "*.min.js").
 */
export function isIgnoredPath(filePath: string, workspaceRoot: string, userPatterns: string[] = []): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const rootNormalized = workspaceRoot.replace(/\\/g, '/');
    const relative = normalized.startsWith(rootNormalized + '/')
        ? normalized.slice(rootNormalized.length + 1)
        : normalized;

    const allPatterns = getAllIgnorePatterns(userPatterns);
    return isIgnoredByPatterns(relative, allPatterns);
}

/**
 * Pure helper for testing: checks if a relative path matches a set of
 * ignore patterns. Does not read VS Code settings.
 */
export function isIgnoredByPatterns(relativePath: string, patterns: string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    for (const pattern of patterns) {
        if (!pattern.includes('*')) {
            if (
                normalized === pattern ||
                normalized.startsWith(pattern + '/') ||
                normalized.includes('/' + pattern + '/') ||
                normalized.endsWith('/' + pattern)
            ) {
                return true;
            }
        }
        // Glob-style pattern: use the ignore library for matching.
        if (pattern.includes('*')) {
            const ig = ignore().add(pattern);
            if (ig.ignores(normalized)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Walks the workspace for indexable files, applying ignore patterns.
 *
 * If more than `maxFiles` files are discovered, the result is truncated to a
 * priority-ordered subset: entry-point-named files first, then most-recently
 * modified, then shallowest directory depth as a final tiebreak. `truncated`
 * and `totalDiscovered` let callers surface budget-limited coverage instead
 * of silently dropping files.
 */
export async function walkFiles(rootPath: string, userPatterns: string[] = [], maxFiles: number = DEFAULT_MAX_FILES): Promise<WalkResult> {
    const allPatterns = getAllIgnorePatterns(userPatterns);
    const ig = ignore().add(allPatterns);

    const gitignorePath = path.join(rootPath, '.gitignore');
    try {
        const gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf-8');
        ig.add(gitignoreContent);
    } catch (e) {
        // Ignore if .gitignore does not exist
    }

    const filePaths: string[] = [];

    async function walk(dir: string, relativeDir: string) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
            const fullPath = path.join(dir, entry.name);

            const checkPath = relativePath.split(path.sep).join('/');
            if (entry.isSymbolicLink()) {
                // Deliberately not followed -- a symlink inside the workspace
                // could otherwise point outside it (e.g. at a home directory
                // or credentials file) and get indexed automatically with no
                // user interaction. `readdir`'s Dirent already reports
                // isDirectory()/isFile() as false for a symlink entry
                // (lstat-equivalent semantics), so this was already the
                // effective behavior; this check makes the skip explicit
                // and self-documenting rather than an implicit fallthrough.
                continue;
            }
            if (entry.isDirectory()) {
                if (ig.ignores(checkPath + '/')) {
                    continue;
                }
                await walk(fullPath, relativePath);
            } else if (entry.isFile()) {
                if (ig.ignores(checkPath)) {
                    continue;
                }
                if (isWalkableFile(entry.name)) {
                    filePaths.push(fullPath);
                }
            }
        }
    }

    await walk(rootPath, '');

    const totalDiscovered = filePaths.length;
    if (totalDiscovered <= maxFiles) {
        return { filePaths, truncated: false, totalDiscovered };
    }

    // Budget exceeded: score only now (avoids a stat() per file in the common,
    // under-budget case) and keep the top `maxFiles` by priority.
    const scored = await Promise.all(filePaths.map(async (filePath) => {
        let mtimeMs = 0;
        try {
            const stat = await fs.promises.stat(filePath);
            mtimeMs = stat.mtimeMs;
        } catch {
            // File vanished between the walk and the stat; treat as lowest priority.
        }
        return {
            filePath,
            depth: filePath.split(path.sep).length,
            mtimeMs,
            isEntryPoint: isEntryPointBasename(filePath)
        };
    }));

    scored.sort((a, b) => {
        if (a.isEntryPoint !== b.isEntryPoint) {
            return a.isEntryPoint ? -1 : 1;
        }
        if (b.mtimeMs !== a.mtimeMs) {
            return b.mtimeMs - a.mtimeMs; // more recently modified first
        }
        return a.depth - b.depth; // shallower directory first
    });

    return {
        filePaths: scored.slice(0, maxFiles).map(s => s.filePath),
        truncated: true,
        totalDiscovered
    };
}
