import * as fs from 'fs';
import * as path from 'path';
import {
    ImportGraph,
    LexicalMap,
    LexicalSymbol
} from './types';

export interface TypeAnnotationMap {
    schemaVersion: string;
    builtAt: string;
    confidence: 1.0;
    files: Record<string, Record<string, {
        params: Record<string, { typeString: string | null; isOptional: boolean }>;
        parameterAnnotations: Record<string, string | null>;
        returns: string | null;
        returnAnnotation: string | null;
    }>>;
}

export type InferredDecoratorRole =
    | 'route'
    | 'middleware'
    | 'static_method'
    | 'class_method'
    | 'property'
    | 'cached'
    | 'event_handler'
    | 'task'
    | 'unknown';

export interface DecoratorMap {
    schemaVersion: string;
    builtAt: string;
    confidence: 1.0;
    files: Record<string, Record<string, {
        decorators: Array<{
            decoratorName: string;
            decoratorArgs: string[];
            inferredRole: InferredDecoratorRole;
        }>;
    }>>;
}

export interface InheritanceMap {
    schemaVersion: string;
    builtAt: string;
    confidence: 1.0;
    classes: Record<string, {
        name: string;
        relativePath: string;
        parents: string[];
        resolvedParents: Array<{ name: string; relativePath: string | null }>;
        children: Array<{ name: string; relativePath: string }>;
        isAbstract: boolean;
        isMixin: boolean;
        interfaces: string[];
    }>;
}

export class TypeAnnotationMapBuilder {
    constructor(private readonly projectRoot: string) {}

    build(lexicalMap: LexicalMap): TypeAnnotationMap {
        const files: TypeAnnotationMap['files'] = {};
        for (const [fileKey, fileEntry] of Object.entries(lexicalMap.files)) {
            const { absolutePath, relativePath } = resolveLexicalPath(this.projectRoot, fileKey);
            const content = readFile(absolutePath);
            const lines = content.split(/\r?\n/);

            for (const symbol of fileEntry.symbols.filter(isFunctionLike)) {
                const signature = collectSignature(lines, symbol);
                const parsed = fileEntry.language === 'python'
                    ? parsePythonSignature(signature)
                    : parseTsSignature(signature);
                const fileMap = files[relativePath] ?? {};
                fileMap[symbolKey(symbol)] = parsed;
                files[relativePath] = fileMap;
            }
        }

        return {
            schemaVersion: '1.0',
            builtAt: new Date().toISOString(),
            confidence: 1.0,
            files
        };
    }
}

export class DecoratorMapBuilder {
    constructor(private readonly projectRoot: string) {}

    build(lexicalMap: LexicalMap): DecoratorMap {
        const files: DecoratorMap['files'] = {};
        for (const [fileKey, fileEntry] of Object.entries(lexicalMap.files)) {
            const { absolutePath, relativePath } = resolveLexicalPath(this.projectRoot, fileKey);
            const lines = readFile(absolutePath).split(/\r?\n/);

            for (const symbol of fileEntry.symbols.filter(symbol =>
                symbol.kind === 'class' || isFunctionLike(symbol)
            )) {
                const decorators = extractDecorators(lines, symbol.startLine);
                if (decorators.length === 0) {
                    continue;
                }
                const fileMap = files[relativePath] ?? {};
                fileMap[symbolKey(symbol)] = { decorators };
                files[relativePath] = fileMap;
            }
        }

        return {
            schemaVersion: '1.0',
            builtAt: new Date().toISOString(),
            confidence: 1.0,
            files
        };
    }
}

export class InheritanceMapBuilder {
    constructor(
        private readonly projectRoot: string,
        private readonly importGraph: ImportGraph
    ) {}

    build(lexicalMap: LexicalMap): InheritanceMap {
        const classes: InheritanceMap['classes'] = {};
        const classIndex = buildClassIndex(lexicalMap);

        for (const [fileKey, fileEntry] of Object.entries(lexicalMap.files)) {
            const { absolutePath, relativePath } = resolveLexicalPath(this.projectRoot, fileKey);
            const lines = readFile(absolutePath).split(/\r?\n/);
            for (const symbol of fileEntry.symbols.filter(item => item.kind === 'class')) {
                const declaration = collectClassDeclaration(lines, symbol);
                const parents = fileEntry.language === 'python'
                    ? parsePythonParents(declaration)
                    : parseTsParents(declaration);
                const interfaces = fileEntry.language === 'typescript' || fileEntry.language === 'javascript'
                    ? parseTsInterfaces(declaration)
                    : [];
                const resolvedParents = parents.map(parentName => ({
                    name: parentName,
                    relativePath: resolveParentPath(parentName, relativePath, this.importGraph, classIndex)
                }));
                const key = classKey(symbol.name, relativePath);
                classes[key] = {
                    name: symbol.name,
                    relativePath,
                    parents,
                    resolvedParents,
                    children: [],
                    isAbstract: isAbstractClass(symbol, declaration, lines, parents),
                    isMixin: isMixinClass(symbol, lines, parents),
                    interfaces
                };
            }
        }

        for (const child of Object.values(classes)) {
            for (const parent of child.resolvedParents) {
                const parentPath = parent.relativePath;
                if (!parentPath) {
                    continue;
                }
                const parentKey = classKey(parent.name, parentPath);
                const parentEntry = classes[parentKey];
                if (parentEntry) {
                    parentEntry.children.push({
                        name: child.name,
                        relativePath: child.relativePath
                    });
                }
            }
        }

        return {
            schemaVersion: '1.0',
            builtAt: new Date().toISOString(),
            confidence: 1.0,
            classes
        };
    }
}

function parsePythonSignature(signature: string): TypeAnnotationMap['files'][string][string] {
    const match = signature.match(/(?:async\s+)?def\s+\w+\s*\(([\s\S]*)\)\s*(?:->\s*([^:]+))?:/);
    const paramsSource = match?.[1] ?? '';
    const returnAnnotation = cleanType(match?.[2] ?? null);
    return buildTypeEntry(parsePythonParams(paramsSource), returnAnnotation);
}

function parseTsSignature(signature: string): TypeAnnotationMap['files'][string][string] {
    const paramsMatch = signature.match(/\(([\s\S]*)\)/);
    const paramsSource = paramsMatch?.[1] ?? '';
    const afterParams = paramsMatch ? signature.slice(signature.indexOf(paramsMatch[0]) + paramsMatch[0].length) : '';
    const returnMatch = afterParams.match(/:\s*([^={;]+)(?:=>|[={;]|$)/);
    return buildTypeEntry(parseTsParams(paramsSource), cleanType(returnMatch?.[1] ?? null));
}

function parsePythonParams(paramsSource: string): Record<string, { typeString: string | null; isOptional: boolean }> {
    const params: Record<string, { typeString: string | null; isOptional: boolean }> = {};
    for (const rawParam of splitTopLevel(paramsSource, ',')) {
        const trimmed = rawParam.trim();
        if (!trimmed || trimmed === 'self' || trimmed === 'cls' || trimmed.startsWith('*')) {
            continue;
        }
        const [left, defaultValue] = splitOnce(trimmed, '=');
        const [name, annotation] = splitOnce(left.trim(), ':');
        const typeString = cleanType(annotation ?? null);
        params[name.trim()] = {
            typeString,
            isOptional: Boolean(defaultValue) || isOptionalType(typeString)
        };
    }
    return params;
}

function parseTsParams(paramsSource: string): Record<string, { typeString: string | null; isOptional: boolean }> {
    const params: Record<string, { typeString: string | null; isOptional: boolean }> = {};
    for (const rawParam of splitTopLevel(paramsSource, ',')) {
        const trimmed = rawParam.trim();
        if (!trimmed) {
            continue;
        }
        const [left, defaultValue] = splitOnce(trimmed, '=');
        const [rawName, annotation] = splitOnce(left.trim(), ':');
        const name = rawName.replace(/[?]/g, '').trim();
        const typeString = cleanType(annotation ?? null);
        params[name] = {
            typeString,
            isOptional: rawName.includes('?') || Boolean(defaultValue) || isOptionalType(typeString)
        };
    }
    return params;
}

function buildTypeEntry(
    params: Record<string, { typeString: string | null; isOptional: boolean }>,
    returnAnnotation: string | null
): TypeAnnotationMap['files'][string][string] {
    const parameterAnnotations: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(params)) {
        parameterAnnotations[name] = value.typeString;
    }
    return {
        params,
        parameterAnnotations,
        returns: returnAnnotation,
        returnAnnotation
    };
}

function extractDecorators(lines: string[], startLine: number): DecoratorMap['files'][string][string]['decorators'] {
    const decorators: DecoratorMap['files'][string][string]['decorators'] = [];
    let cursor = startLine - 2;
    while (cursor >= 0) {
        const trimmed = lines[cursor].trim();
        if (!trimmed) {
            cursor -= 1;
            continue;
        }
        if (!trimmed.startsWith('@')) {
            break;
        }
        const parsed = parseDecorator(trimmed);
        decorators.unshift(parsed);
        cursor -= 1;
    }
    return decorators;
}

function parseDecorator(line: string): DecoratorMap['files'][string][string]['decorators'][number] {
    const source = line.slice(1).trim();
    const callMatch = source.match(/^([A-Za-z_][\w.]*)\s*\((.*)\)$/);
    const decoratorName = callMatch ? callMatch[1] : source;
    const decoratorArgs = callMatch ? splitTopLevel(callMatch[2], ',').map(arg => arg.trim()).filter(Boolean) : [];
    return {
        decoratorName,
        decoratorArgs,
        inferredRole: inferDecoratorRole(decoratorName)
    };
}

function inferDecoratorRole(decoratorName: string): InferredDecoratorRole {
    if (/^(router|app)\.(get|post|put|delete|patch|options|head)$/.test(decoratorName)) {
        return 'route';
    }
    if (decoratorName === 'staticmethod') {
        return 'static_method';
    }
    if (decoratorName === 'classmethod') {
        return 'class_method';
    }
    if (decoratorName === 'property') {
        return 'property';
    }
    if (decoratorName === 'lru_cache' || decoratorName === 'cache' || decoratorName.endsWith('.lru_cache')) {
        return 'cached';
    }
    if (decoratorName === 'shared_task' || decoratorName === 'celery.task') {
        return 'task';
    }
    if (decoratorName.toLowerCase().includes('middleware')) {
        return 'middleware';
    }
    if (decoratorName.toLowerCase().includes('event')) {
        return 'event_handler';
    }
    return 'unknown';
}

function collectSignature(lines: string[], symbol: LexicalSymbol): string {
    const chunks: string[] = [];
    for (let index = symbol.startLine - 1; index < Math.min(lines.length, symbol.startLine + 15); index += 1) {
        chunks.push(lines[index].trim());
        const joined = chunks.join(' ');
        if (symbol.language === 'python' && joined.includes(':') && balanced(joined)) {
            break;
        }
        if (symbol.language !== 'python' && (joined.includes('{') || joined.includes('=>') || joined.includes(';')) && balanced(joined)) {
            break;
        }
    }
    return chunks.join(' ');
}

function collectClassDeclaration(lines: string[], symbol: LexicalSymbol): string {
    const chunks: string[] = [];
    for (let index = symbol.startLine - 1; index < Math.min(lines.length, symbol.startLine + 10); index += 1) {
        chunks.push(lines[index].trim());
        const joined = chunks.join(' ');
        if (symbol.language === 'python' && joined.includes(':') && balanced(joined)) {
            break;
        }
        if (symbol.language !== 'python' && (joined.includes('{') || joined.includes(';')) && balanced(joined)) {
            break;
        }
    }
    return chunks.join(' ');
}

function parsePythonParents(declaration: string): string[] {
    const match = declaration.match(/class\s+\w+\s*\((.*)\)\s*:/);
    if (!match) {
        return [];
    }
    return splitTopLevel(match[1], ',')
        .map(parent => parent.trim().split('[')[0].split('.').pop() ?? '')
        .filter(Boolean);
}

function parseTsParents(declaration: string): string[] {
    const match = declaration.match(/\bextends\s+([A-Za-z_][\w.]*)/);
    return match ? [match[1].split('.').pop() ?? match[1]] : [];
}

function parseTsInterfaces(declaration: string): string[] {
    const match = declaration.match(/\bimplements\s+([^{]+)/);
    if (!match) {
        return [];
    }
    return splitTopLevel(match[1], ',')
        .map(item => item.trim().split('<')[0])
        .filter(Boolean);
}

function resolveParentPath(
    parentName: string,
    childRelativePath: string,
    importGraph: ImportGraph,
    classIndex: Map<string, string[]>
): string | null {
    const localClasses = classIndex.get(parentName) ?? [];
    if (localClasses.includes(childRelativePath)) {
        return childRelativePath;
    }
    const imported = importGraph.edges.find(edge =>
        edge.from === childRelativePath &&
        edge.type !== 'external' &&
        edge.importedNames.includes(parentName)
    );
    if (imported) {
        return imported.to;
    }
    return localClasses.length === 1 ? localClasses[0] : null;
}

function buildClassIndex(lexicalMap: LexicalMap): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const [fileKey, fileEntry] of Object.entries(lexicalMap.files)) {
        const { relativePath } = resolveLexicalPath(lexicalMap.projectRoot, fileKey);
        for (const symbol of fileEntry.symbols.filter(item => item.kind === 'class')) {
            const existing = index.get(symbol.name) ?? [];
            existing.push(relativePath);
            index.set(symbol.name, existing);
        }
    }
    return index;
}

function resolveLexicalPath(projectRoot: string, fileKey: string): { absolutePath: string; relativePath: string } {
    const absolutePath = path.isAbsolute(fileKey)
        ? fileKey
        : path.join(projectRoot, fileKey);
    const relativePath = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
    return { absolutePath, relativePath };
}

function isAbstractClass(
    symbol: LexicalSymbol,
    declaration: string,
    lines: string[],
    parents: string[]
): boolean {
    if (parents.some(parent => ['ABC', 'Protocol'].includes(parent))) {
        return true;
    }
    if (/abstract\s+class\s+/.test(declaration)) {
        return true;
    }
    const classBody = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    return classBody.includes('@abstractmethod') || classBody.includes('abstract ');
}

function isMixinClass(symbol: LexicalSymbol, lines: string[], parents: string[]): boolean {
    if (symbol.name.endsWith('Mixin')) {
        return true;
    }
    const classBody = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    const hasInit = /\bdef\s+__init__\s*\(/.test(classBody) || /\bconstructor\s*\(/.test(classBody);
    return !hasInit && (parents.length === 0 || parents.every(parent => parent === 'object'));
}

function isFunctionLike(symbol: LexicalSymbol): boolean {
    return symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor';
}

function symbolKey(symbol: LexicalSymbol): string {
    return symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
}

function classKey(name: string, relativePath: string): string {
    return `${relativePath}:${name}`;
}

function splitTopLevel(source: string, delimiter: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of source) {
        if (char === '(' || char === '[' || char === '<' || char === '{') {
            depth += 1;
        } else if (char === ')' || char === ']' || char === '>' || char === '}') {
            depth = Math.max(0, depth - 1);
        }
        if (char === delimiter && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) {
        parts.push(current);
    }
    return parts;
}

function splitOnce(source: string, delimiter: string): [string, string | null] {
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '(' || char === '[' || char === '<' || char === '{') {
            depth += 1;
        } else if (char === ')' || char === ']' || char === '>' || char === '}') {
            depth = Math.max(0, depth - 1);
        } else if (char === delimiter && depth === 0) {
            return [source.slice(0, index), source.slice(index + 1)];
        }
    }
    return [source, null];
}

function cleanType(value: string | null): string | null {
    if (!value) {
        return null;
    }
    return value.trim().replace(/,$/, '').replace(/\s+/g, ' ') || null;
}

function isOptionalType(typeString: string | null): boolean {
    if (!typeString) {
        return false;
    }
    return /\bOptional\s*\[/.test(typeString) ||
        /\bUnion\s*\[[^\]]*\bNone\b/.test(typeString) ||
        /\|\s*(None|null|undefined)\b/.test(typeString) ||
        /\b(None|null|undefined)\s*\|/.test(typeString);
}

function balanced(source: string): boolean {
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };
    const stack: string[] = [];
    for (const char of source) {
        if (char === '(' || char === '[' || char === '{' || char === '<') {
            stack.push(char);
        } else if (char === ')' || char === ']' || char === '}' || char === '>') {
            if (stack.pop() !== pairs[char]) {
                return false;
            }
        }
    }
    return stack.length === 0;
}

function readFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}
