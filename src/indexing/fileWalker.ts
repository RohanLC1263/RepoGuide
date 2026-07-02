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
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.kt', '.rb', '.cs', '.php', '.swift', '.md'
]);

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
 * Returns true if the given file path has an allowed extension for indexing.
 */
export function isWalkableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
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

export async function walkFiles(rootPath: string, userPatterns: string[] = []): Promise<string[]> {
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
            if (entry.isDirectory()) {
                if (ig.ignores(checkPath + '/')) {
                    continue;
                }
                await walk(fullPath, relativePath);
            } else if (entry.isFile()) {
                if (ig.ignores(checkPath)) {
                    continue;
                }
                const ext = path.extname(entry.name).toLowerCase();
                if (ALLOWED_EXTENSIONS.has(ext)) {
                    filePaths.push(fullPath);
                }
            }
        }
    }

    await walk(rootPath, '');

    const MAX_FILES = 2000;
    if (filePaths.length > MAX_FILES) {
        console.warn(`RepoGuide: ${filePaths.length} files found, limiting to ${MAX_FILES}`);
        // Prioritize by directory depth (shallower = more important)
        filePaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
        return filePaths.slice(0, MAX_FILES);
    }

    return filePaths;
}
