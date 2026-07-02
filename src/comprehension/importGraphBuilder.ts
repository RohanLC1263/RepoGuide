import * as fs from 'fs';
import * as path from 'path';
import { FileStructure, ImportEdge, ImportGraph } from './types';

type OutputLogger = {
    appendLine(message: string): void;
};

interface ParsedImport {
    importString: string;
    moduleName: string;
    importedNames: string[];
    isWildcard: boolean;
    isRelative: boolean;
    isDynamic: boolean;
    lineNumber: number;
}

interface ResolutionResult {
    type: 'local' | 'external';
    to: string;
    reason?: string;
}

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PYTHON_EXTENSIONS = ['.py'];

export class ImportGraphBuilder {
    private readonly relativeFiles = new Set<string>();
    private readonly absoluteFiles = new Set<string>();
    private readonly packageRoots: string[];

    constructor(
        private readonly projectRoot: string,
        fileStructures: FileStructure[],
        private readonly outputChannel?: OutputLogger
    ) {
        for (const structure of fileStructures) {
            this.relativeFiles.add(toRelativePath(projectRoot, structure.filePath));
            this.absoluteFiles.add(path.normalize(structure.filePath));
        }
        this.packageRoots = detectPackageRoots(projectRoot);
    }

    build(fileStructures: FileStructure[]): ImportGraph {
        const nodes: ImportGraph['nodes'] = {};
        const edges: ImportEdge[] = [];
        const externalPackages = new Set<string>();
        const unresolvedImports: ImportGraph['unresolvedImports'] = [];

        for (const structure of fileStructures) {
            const from = toRelativePath(this.projectRoot, structure.filePath);
            nodes[from] = {
                language: structure.language,
                isEntryPoint: isLikelyEntryPoint(from, structure),
                isExternal: false
            };

            const content = readFile(structure.filePath);
            const parsedImports = parseImports(structure.filePath, structure.language, content);
            for (const parsed of parsedImports) {
                const resolution = this.resolveImport(structure.filePath, structure.language, parsed);
                if (!resolution) {
                    unresolvedImports.push({
                        from,
                        importString: parsed.importString,
                        reason: 'Could not resolve local relative import target.'
                    });
                    continue;
                }

                if (resolution.type === 'external') {
                    externalPackages.add(resolution.to);
                    nodes[resolution.to] = {
                        language: 'external',
                        isEntryPoint: false,
                        isExternal: true
                    };
                    edges.push(edge(from, resolution.to, parsed.isDynamic ? 'dynamic' : 'external', parsed));
                    continue;
                }

                if (!this.relativeFiles.has(resolution.to)) {
                    unresolvedImports.push({
                        from,
                        importString: parsed.importString,
                        reason: resolution.reason ?? 'Resolved target is not part of analyzed file set.'
                    });
                    continue;
                }

                edges.push(edge(from, resolution.to, parsed.isDynamic ? 'dynamic' : 'local', parsed));
            }
        }

        const localEdges = edges.filter(item => item.type === 'local' || item.type === 'dynamic' && !externalPackages.has(item.to)).length;
        const externalEdges = edges.filter(item => item.type === 'external').length;
        const graph: ImportGraph = {
            schemaVersion: '1.0',
            builtAt: new Date().toISOString(),
            nodes,
            edges,
            externalPackages: Array.from(externalPackages).sort(),
            unresolvedImports,
            stats: {
                totalEdges: edges.length,
                localEdges,
                externalEdges,
                unresolvedCount: unresolvedImports.length
            }
        };

        this.outputChannel?.appendLine(
            `[Info] Import graph: ${graph.stats.totalEdges} edges ` +
            `(${graph.stats.localEdges} local, ${graph.stats.externalEdges} external, ` +
            `${graph.stats.unresolvedCount} unresolved)`
        );

        return graph;
    }

    private resolveImport(
        importingFilePath: string,
        language: string,
        parsed: ParsedImport
    ): ResolutionResult | null {
        if (language === 'python') {
            return this.resolvePythonImport(importingFilePath, parsed);
        }

        if (language === 'typescript' || language === 'javascript') {
            return this.resolveTsJsImport(importingFilePath, parsed);
        }

        if (parsed.isRelative) {
            return null;
        }

        return {
            type: 'external',
            to: packageName(parsed.moduleName)
        };
    }

    private resolvePythonImport(importingFilePath: string, parsed: ParsedImport): ResolutionResult | null {
        if (parsed.isRelative) {
            const resolved = resolvePythonRelativeImport(
                importingFilePath,
                parsed.moduleName,
                parsed.importedNames,
                this.projectRoot
            );
            return resolved ? { type: 'local', to: resolved } : null;
        }

        const local = resolvePythonAbsoluteImport(
            parsed.moduleName,
            parsed.importedNames,
            this.projectRoot,
            this.packageRoots
        );
        if (local) {
            return { type: 'local', to: local };
        }

        return {
            type: 'external',
            to: packageName(parsed.moduleName)
        };
    }

    private resolveTsJsImport(importingFilePath: string, parsed: ParsedImport): ResolutionResult | null {
        if (parsed.isRelative) {
            const resolved = resolveTsJsRelativeImport(
                importingFilePath,
                parsed.moduleName,
                this.projectRoot
            );
            return resolved ? { type: 'local', to: resolved } : null;
        }

        return {
            type: 'external',
            to: packageName(parsed.moduleName)
        };
    }
}

function parseImports(filePath: string, language: string, content: string): ParsedImport[] {
    if (!content) {
        return [];
    }
    if (language === 'python') {
        return parsePythonImports(content);
    }
    if (language === 'typescript' || language === 'javascript') {
        return parseTsJsImports(content);
    }
    return [];
}

function parsePythonImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const line = stripInlineComment(lines[index]).trim();
        if (!line) {
            continue;
        }

        const fromMatch = line.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
        if (fromMatch) {
            const moduleName = fromMatch[1];
            const rawNames = fromMatch[2].trim();
            const isWildcard = rawNames === '*';
            imports.push({
                importString: line,
                moduleName,
                importedNames: isWildcard ? ['*'] : parseImportedNames(rawNames),
                isWildcard,
                isRelative: moduleName.startsWith('.'),
                isDynamic: false,
                lineNumber
            });
            continue;
        }

        const importMatch = line.match(/^import\s+(.+)$/);
        if (importMatch) {
            for (const segment of importMatch[1].split(',')) {
                const raw = segment.trim();
                if (!raw) {
                    continue;
                }
                const aliasMatch = raw.match(/^([\w.]+)\s+as\s+(\w+)$/);
                const moduleName = aliasMatch ? aliasMatch[1] : raw;
                const alias = aliasMatch ? aliasMatch[2] : moduleName.split('.')[0];
                imports.push({
                    importString: `import ${raw}`,
                    moduleName,
                    importedNames: [alias],
                    isWildcard: false,
                    isRelative: moduleName.startsWith('.'),
                    isDynamic: false,
                    lineNumber
                });
            }
        }
    }
    return imports;
}

function parseTsJsImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const line = lines[index].trim();
        if (!line || line.startsWith('//')) {
            continue;
        }

        const sideEffect = line.match(/^import\s+['"]([^'"]+)['"]/);
        const fromImport = line.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/);
        const requireImport = line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
        const dynamicImport = line.match(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/);

        if (fromImport) {
            imports.push({
                importString: line,
                moduleName: fromImport[2],
                importedNames: parseTsImportedNames(fromImport[1]),
                isWildcard: fromImport[1].includes('*'),
                isRelative: fromImport[2].startsWith('.'),
                isDynamic: false,
                lineNumber
            });
            continue;
        }

        if (sideEffect) {
            imports.push({
                importString: line,
                moduleName: sideEffect[1],
                importedNames: ['*'],
                isWildcard: true,
                isRelative: sideEffect[1].startsWith('.'),
                isDynamic: false,
                lineNumber
            });
        }

        if (requireImport) {
            imports.push({
                importString: line,
                moduleName: requireImport[1],
                importedNames: ['*'],
                isWildcard: true,
                isRelative: requireImport[1].startsWith('.'),
                isDynamic: false,
                lineNumber
            });
        }

        if (dynamicImport) {
            imports.push({
                importString: line,
                moduleName: dynamicImport[1],
                importedNames: ['*'],
                isWildcard: true,
                isRelative: dynamicImport[1].startsWith('.'),
                isDynamic: true,
                lineNumber
            });
        }
    }
    return imports;
}

function resolvePythonRelativeImport(
    importingFilePath: string,
    moduleName: string,
    importedNames: string[],
    projectRoot: string
): string | null {
    const leadingDots = moduleName.match(/^\.+/)?.[0].length ?? 0;
    const remainder = moduleName.slice(leadingDots).split('.').filter(Boolean);
    let baseDir = path.dirname(importingFilePath);
    for (let i = 1; i < leadingDots; i += 1) {
        baseDir = path.dirname(baseDir);
    }

    const moduleBase = path.join(baseDir, ...remainder);
    return firstExistingRelative(projectRoot, pythonCandidates(moduleBase, importedNames));
}

function resolvePythonAbsoluteImport(
    moduleName: string,
    importedNames: string[],
    projectRoot: string,
    packageRoots: string[]
): string | null {
    const moduleParts = moduleName.split('.').filter(Boolean);
    const candidates: string[] = [];

    for (const root of packageRoots) {
        const moduleBase = path.join(root, ...moduleParts);
        candidates.push(...pythonCandidates(moduleBase, importedNames));
    }

    return firstExistingRelative(projectRoot, candidates);
}

function pythonCandidates(moduleBase: string, importedNames: string[]): string[] {
    const candidates = [
        `${moduleBase}.py`,
        path.join(moduleBase, '__init__.py')
    ];

    for (const name of importedNames.filter(item => item !== '*')) {
        candidates.push(
            path.join(moduleBase, `${name}.py`),
            path.join(moduleBase, name, '__init__.py')
        );
    }

    return candidates;
}

function resolveTsJsRelativeImport(
    importingFilePath: string,
    moduleName: string,
    projectRoot: string
): string | null {
    const base = path.resolve(path.dirname(importingFilePath), moduleName);
    const candidates: string[] = [];
    for (const ext of TS_JS_EXTENSIONS) {
        candidates.push(`${base}${ext}`);
    }
    for (const ext of TS_JS_EXTENSIONS) {
        candidates.push(path.join(base, `index${ext}`));
    }
    return firstExistingRelative(projectRoot, candidates);
}

function firstExistingRelative(projectRoot: string, candidates: string[]): string | null {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return toRelativePath(projectRoot, candidate);
        }
    }
    return null;
}

function detectPackageRoots(projectRoot: string): string[] {
    const roots = [projectRoot];
    for (const dirname of ['src', 'app']) {
        const candidate = path.join(projectRoot, dirname);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            roots.push(candidate);
        }
    }
    try {
        for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const candidate = path.join(projectRoot, entry.name);
            if (!roots.includes(candidate)) {
                roots.push(candidate);
            }
        }
    } catch {
        // Best-effort package root discovery.
    }
    return roots;
}

function edge(
    from: string,
    to: string,
    type: ImportEdge['type'],
    parsed: ParsedImport
): ImportEdge {
    return {
        from,
        to,
        type,
        importedNames: parsed.importedNames,
        isWildcard: parsed.isWildcard,
        lineNumber: parsed.lineNumber
    };
}

function parseImportedNames(rawNames: string): string[] {
    return rawNames
        .replace(/[()]/g, '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
            return aliasMatch ? aliasMatch[1] : item;
        });
}

function parseTsImportedNames(rawNames: string): string[] {
    if (rawNames.includes('*')) {
        return ['*'];
    }

    const names = rawNames
        .replace(/[{}]/g, '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
            return aliasMatch ? aliasMatch[1] : item;
        });

    return names.length > 0 ? names : ['default'];
}

function isLikelyEntryPoint(relativePath: string, structure: FileStructure): boolean {
    const base = path.basename(relativePath).toLowerCase();
    return base === 'main.py' ||
        base === 'index.ts' ||
        base === 'index.js' ||
        structure.topLevelCalls.length > 0;
}

function packageName(moduleName: string): string {
    if (moduleName.startsWith('@')) {
        return moduleName.split('/').slice(0, 2).join('/');
    }
    return moduleName.split('.')[0].split('/')[0];
}

function stripInlineComment(line: string): string {
    const commentIndex = line.indexOf('#');
    return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function toRelativePath(projectRoot: string, filePath: string): string {
    return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function readFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}
