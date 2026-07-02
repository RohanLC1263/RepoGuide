import * as path from 'path';
import { AnnotationSignal } from '../comprehension/fileAnnotationEngine';

export type ErrorAnchorType = 'file' | 'symbol' | 'package' | 'line' | 'test' | 'config';

export interface ErrorAnchor {
    type: ErrorAnchorType;
    value: string;
    line?: number;
    confidence: number;
}

export interface PreprocessedError {
    error_type:
        | 'typescript_compiler'
        | 'test_failure'
        | 'package_linking'
        | 'runtime_exception'
        | 'node_module_resolution'
        | 'stack_trace'
        | 'unknown';
    message: string;
    anchors: ErrorAnchor[];
    preferred_annotation_signals: AnnotationSignal[];
    search_queries: string[];
}

const CONFIG_FILES = new Set([
    'package.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'jsconfig.json',
    'vite.config.ts',
    'vite.config.js',
    'webpack.config.js',
    'jest.config.js',
    'vitest.config.ts',
    '.yarnrc.yml',
    '.npmrc'
]);
const PACKAGE_ANCHOR_STOPWORDS = new Set([
    'string', 'number', 'boolean', 'object', 'undefined', 'null', 'type',
    'error', 'warning', 'found', 'expected', 'received', 'failed', 'module'
]);

export function preprocessError(raw: string, problemDescription = ''): PreprocessedError {
    const cleaned = stripAnsi(raw).replace(/\r/g, '');
    const combined = [problemDescription, cleaned].filter(Boolean).join('\n').trim();
    const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
    const message = extractMessage(lines, problemDescription);
    const errorType = classifyError(combined);
    const anchors = dedupeAnchors([
        ...extractTypeScriptAnchors(lines),
        ...extractStackAnchors(lines),
        ...extractModuleResolutionAnchors(lines),
        ...extractPackageAnchors(lines),
        ...extractTestAnchors(lines),
        ...extractConfigAnchors(lines)
    ]);
    const preferred = preferredSignalsFor(errorType, combined);
    const searchQueries = buildSearchQueries(message, lines, anchors, problemDescription);

    return {
        error_type: errorType,
        message,
        anchors,
        preferred_annotation_signals: preferred,
        search_queries: searchQueries
    };
}

export function stripAnsi(value: string): string {
    return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function classifyError(text: string): PreprocessedError['error_type'] {
    const lower = text.toLowerCase();
    if (/\berror\s+ts\d{4}\b/i.test(text) || /\btsc\b/.test(lower)) {
        return 'typescript_compiler';
    }
    if (/cannot find module|module not found|err_module_not_found|cannot resolve module/i.test(text)) {
        return 'node_module_resolution';
    }
    if (/jest|vitest|mocha|failed tests?|test suite failed|expect\(/i.test(text)) {
        return 'test_failure';
    }
    if (/yarn|npm|pnpm|node_modules|pnp|peer depend|lockfile|linker|workspace:/i.test(text)) {
        return 'package_linking';
    }
    if (/^\s*at\s+.+\(.+:\d+:\d+\)/m.test(text) || /\b[A-Za-z]*Error:\s+/.test(text)) {
        return 'stack_trace';
    }
    if (/exception|traceback|runtimeerror|typeerror|referenceerror|syntaxerror/i.test(text)) {
        return 'runtime_exception';
    }
    return 'unknown';
}

function extractMessage(lines: string[], problemDescription: string): string {
    const candidates = [
        ...lines.filter(line =>
            /\berror\s+ts\d{4}\b/i.test(line) ||
            /cannot find module|module not found|err_module_not_found/i.test(line) ||
            /\b[A-Za-z]*Error:\s+/.test(line) ||
            /failed|failure/i.test(line)
        ),
        ...lines.slice(0, 3)
    ];
    const picked = candidates.find(Boolean) ?? problemDescription.trim() ?? 'Terminal command failed.';
    return truncate(picked.replace(/\s+/g, ' '), 500);
}

function extractTypeScriptAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    const tsPattern = /^(.+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s+error\s+(TS\d{4})/i;
    for (const line of lines) {
        const match = line.match(tsPattern);
        if (!match) {
            continue;
        }
        anchors.push({ type: 'file', value: normalizeFile(match[1]), line: Number(match[2]), confidence: 0.98 });
        anchors.push({ type: 'line', value: `${normalizeFile(match[1])}:${match[2]}`, line: Number(match[2]), confidence: 0.95 });
        anchors.push({ type: 'symbol', value: match[4], confidence: 0.65 });
    }
    return anchors;
}

function extractStackAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    const stackPatterns = [
        /\bat\s+(?:(?<symbol>[A-Za-z_$][\w$.[\]<>]*)\s+)?\((?<file>[^()]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):(?<line>\d+):(?<col>\d+)\)/,
        /\bat\s+(?<file>[^()]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):(?<line>\d+):(?<col>\d+)/
    ];
    for (const line of lines) {
        for (const pattern of stackPatterns) {
            const match = line.match(pattern);
            const groups = match?.groups;
            if (!groups?.file) {
                continue;
            }
            anchors.push({ type: 'file', value: normalizeFile(groups.file), line: Number(groups.line), confidence: 0.95 });
            anchors.push({ type: 'line', value: `${normalizeFile(groups.file)}:${groups.line}`, line: Number(groups.line), confidence: 0.9 });
            if (groups.symbol) {
                anchors.push({ type: 'symbol', value: groups.symbol.replace(/^Object\./, ''), confidence: 0.8 });
            }
            break;
        }
    }
    return anchors;
}

function extractModuleResolutionAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    for (const line of lines) {
        const moduleMatch = line.match(/(?:cannot find module|module not found|cannot resolve module)\s+['"]([^'"]+)['"]/i) ??
            line.match(/ERR_MODULE_NOT_FOUND.*?['"]([^'"]+)['"]/i);
        if (moduleMatch) {
            anchors.push({ type: 'package', value: moduleMatch[1], confidence: 0.95 });
        }
        const requireStackMatch = line.match(/Require stack:\s*(.*)$/i);
        if (requireStackMatch?.[1]) {
            anchors.push({ type: 'file', value: normalizeFile(requireStackMatch[1]), confidence: 0.7 });
        }
    }
    return anchors;
}

function extractPackageAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    for (const line of lines) {
        for (const match of line.matchAll(/(?:@[\w.-]+\/)?[\w.-]+@(?:npm:)?\d+\.\d+\.\d+|(?:@[\w.-]+\/)?[\w.-]+(?=\s+(?:isn't|is not|couldn't|could not|missing|unmet|peer))/g)) {
            const value = match[0].replace(/@(?:npm:)?\d+\.\d+\.\d+$/, '');
            if (!PACKAGE_ANCHOR_STOPWORDS.has(value.toLowerCase())) {
                anchors.push({ type: 'package', value, confidence: 0.75 });
            }
        }
        if (/yarn|npm|pnpm|node_modules|pnp|lockfile|peer depend|workspace:/i.test(line)) {
            anchors.push({ type: 'config', value: 'package.json', confidence: 0.7 });
        }
    }
    return anchors;
}

function extractTestAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    for (const line of lines) {
        const testFile = line.match(/([^:\s]+(?:\.test|\.spec)\.(?:ts|tsx|js|jsx))(?::(\d+))?/i);
        if (testFile) {
            anchors.push({ type: 'test', value: normalizeFile(testFile[1]), line: testFile[2] ? Number(testFile[2]) : undefined, confidence: 0.9 });
            anchors.push({ type: 'file', value: normalizeFile(testFile[1]), line: testFile[2] ? Number(testFile[2]) : undefined, confidence: 0.85 });
        }
    }
    return anchors;
}

function extractConfigAnchors(lines: string[]): ErrorAnchor[] {
    const anchors: ErrorAnchor[] = [];
    for (const line of lines) {
        for (const config of CONFIG_FILES) {
            if (line.toLowerCase().includes(config.toLowerCase())) {
                anchors.push({ type: 'config', value: config, confidence: 0.85 });
            }
        }
    }
    return anchors;
}

function preferredSignalsFor(errorType: PreprocessedError['error_type'], text: string): AnnotationSignal[] {
    const signals = new Set<AnnotationSignal>(['error_boundary']);
    if (errorType === 'typescript_compiler' || errorType === 'node_module_resolution' || errorType === 'package_linking') {
        signals.add('configuration');
    }
    if (/async|promise|await|timeout/i.test(text)) {
        signals.add('async_pattern');
    }
    if (/write|mutat|cache|lockfile|node_modules|link/i.test(text)) {
        signals.add('mutates_state');
    }
    if (/fetch|http|registry|network|download|external/i.test(text)) {
        signals.add('external_call');
    }
    return Array.from(signals);
}

function buildSearchQueries(
    message: string,
    lines: string[],
    anchors: ErrorAnchor[],
    problemDescription: string
): string[] {
    const symbols = anchors.filter(anchor => anchor.type === 'symbol').map(anchor => anchor.value);
    const files = anchors.filter(anchor => anchor.type === 'file' || anchor.type === 'test').map(anchor => path.basename(anchor.value));
    const packages = anchors.filter(anchor => anchor.type === 'package').map(anchor => anchor.value);
    const stackLines = lines.filter(line => /\bat\s+|error\s+TS\d{4}|cannot find module|module not found/i.test(line)).slice(0, 5);
    return unique([
        problemDescription,
        message,
        [...symbols, ...files, ...packages].join(' '),
        stackLines.join(' '),
        ...packages.map(pkg => `package config dependency ${pkg}`),
        ...files.map(file => `error near ${file}`)
    ].map(query => query.replace(/\s+/g, ' ').trim()).filter(query => query.length > 0)).slice(0, 8);
}

function dedupeAnchors(anchors: ErrorAnchor[]): ErrorAnchor[] {
    const seen = new Set<string>();
    const deduped: ErrorAnchor[] = [];
    for (const anchor of anchors) {
        const key = `${anchor.type}:${anchor.value}:${anchor.line ?? ''}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(anchor);
    }
    return deduped.sort((a, b) => b.confidence - a.confidence).slice(0, 24);
}

function normalizeFile(filePath: string): string {
    return filePath.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}

function truncate(text: string, maxLength: number): string {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
