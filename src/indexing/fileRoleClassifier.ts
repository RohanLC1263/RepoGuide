import * as path from 'path';
import type { LogicalUnitRole } from './logicalUnitTypes';

const GENERATED_COMPONENTS = new Set([
    'dist',
    'out',
    'build',
    'coverage',
    'generated',
    '.next',
    'node_modules',
    '__pycache__',
    '.mypy_cache',
    '.pytest_cache'
]);

const GENERATED_FILENAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'poetry.lock',
    'pipfile.lock',
    'pnpm-lock.yaml',
    'bun.lockb'
]);

const TEST_COMPONENTS = new Set([
    'tests',
    'test',
    '__tests__',
    'e2e',
    'fixtures',
    'mocks',
    'stubs',
    'fakes',
    'spec',
    'specs',
    'cypress'
]);

const CONFIG_FILENAMES = new Set([
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'vite.config.ts',
    'vite.config.js',
    'webpack.config.js',
    'webpack.config.ts',
    'jest.config.js',
    'jest.config.ts',
    'jest.config.cjs',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.prettierrc',
    '.prettierrc.json',
    'docker-compose.yml',
    'docker-compose.yaml',
    'dockerfile',
    '.env.example',
    '.env.sample',
    'requirements.txt',
    'requirements-dev.txt',
    'makefile'
]);

// Single-file bundles/vendored builds (e.g. a package manager's own CLI
// shipped as a compiled artifact) are drastically larger than any realistic
// hand-written source file -- far above typical large files (tens of KB) but
// far below what this threshold would need to be to false-positive on one.
const BUNDLED_FILE_SIZE_THRESHOLD = 500 * 1024;

const DOC_COMPONENTS = new Set(['docs', 'documentation', 'wiki']);
const DOC_FILENAMES = new Set([
    'readme.md',
    'readme.rst',
    'changelog.md',
    'contributing.md',
    'license'
]);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const SOURCE_COMPONENTS = new Set(['src', 'lib', 'app', 'packages', 'pkg']);
const SCRIPT_COMPONENTS = new Set(['scripts', 'tools', 'bin', 'cli']);
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd']);
const SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.rb',
    '.php',
    '.cs',
    '.cpp',
    '.c',
    '.h',
    '.swift',
    '.kt',
    '.scala'
]);

/**
 * Classifies a repository file for proof-first evidence retrieval.
 *
 * Files classified as 'test' or 'generated' are HARD SUPPRESSED in evidence
 * retrieval for non-test queries. This means they are removed from candidate
 * sets before scoring, not after. A test file with a perfect BM25 score must
 * not appear in an EvidencePacket for an implementation query.
 */
export function classifyFileRole(filePath: string, content?: string): LogicalUnitRole {
    const normalized = normalizePath(filePath);
    const components = pathComponents(normalized);
    const filename = path.posix.basename(normalized);
    const extension = path.posix.extname(filename);

    if (isGeneratedPath(components, filename) || isBundledFile(extension, content)) {
        return 'generated';
    }

    if (isTestPath(components, filename) || hasTestContentHeuristic(content)) {
        return 'test';
    }

    if (isConfigPath(normalized, filename)) {
        return 'config';
    }

    if (isDocsPath(components, filename, extension)) {
        return 'docs';
    }

    if (components.some(component => SCRIPT_COMPONENTS.has(component)) || SCRIPT_EXTENSIONS.has(extension)) {
        return 'script';
    }

    if (SOURCE_EXTENSIONS.has(extension)) {
        return 'implementation';
    }

    return 'unknown';
}

export function isTestFile(filePath: string, content?: string): boolean {
    return classifyFileRole(filePath, content) === 'test';
}

export function isImplementationFile(filePath: string, content?: string): boolean {
    return classifyFileRole(filePath, content) === 'implementation';
}

function isBundledFile(extension: string, content?: string): boolean {
    return SOURCE_EXTENSIONS.has(extension) && !!content && content.length > BUNDLED_FILE_SIZE_THRESHOLD;
}

function isGeneratedPath(components: string[], filename: string): boolean {
    if (components.some(component => GENERATED_COMPONENTS.has(component))) {
        return true;
    }
    if (GENERATED_FILENAMES.has(filename)) {
        return true;
    }
    return filename.endsWith('.min.js') ||
        filename.endsWith('.min.css') ||
        filename.endsWith('.map') ||
        filename.endsWith('-lock.json') ||
        filename.endsWith('.lock');
}

function isTestPath(components: string[], filename: string): boolean {
    if (components.some(component => TEST_COMPONENTS.has(component))) {
        return true;
    }
    return /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(filename) ||
        /^test_.*\.py$/.test(filename) ||
        /^verify_.*\.py$/.test(filename) ||
        /_test\.py$/.test(filename);
}

function isConfigPath(normalized: string, filename: string): boolean {
    if (CONFIG_FILENAMES.has(filename)) {
        return true;
    }
    if (/^tsconfig\..*\.json$/.test(filename)) {
        return true;
    }
    return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized);
}

function isDocsPath(components: string[], filename: string, extension: string): boolean {
    if (components.some(component => DOC_COMPONENTS.has(component))) {
        return true;
    }
    if (DOC_FILENAMES.has(filename)) {
        return true;
    }
    return DOC_EXTENSIONS.has(extension) &&
        !components.some(component => SOURCE_COMPONENTS.has(component));
}

function hasTestContentHeuristic(content?: string): boolean {
    if (!content) {
        return false;
    }
    const firstLines = content
        .split(/\r?\n/)
        .slice(0, 20)
        .join('\n')
        .toLowerCase();

    return firstLines.includes('import pytest') ||
        firstLines.includes('from pytest') ||
        firstLines.includes('import unittest') ||
        firstLines.includes('import { describe') ||
        firstLines.includes('import { it,') ||
        firstLines.includes('import { test,') ||
        firstLines.includes('const describe =') ||
        firstLines.includes('const it =') ||
        firstLines.includes('describe(') ||
        firstLines.includes('it(');
}

function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function pathComponents(normalizedPath: string): string[] {
    return normalizedPath.split('/').filter(Boolean);
}
