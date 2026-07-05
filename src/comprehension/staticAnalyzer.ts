import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Parser = require('node-tree-sitter');
import { detectLanguage, getTreeSitterLanguage } from '../indexing/languageDetector';
import { parseSourceSafely } from '../indexing/treeSitterParse';
import {
    ClassSignature,
    ExportReference,
    FileStructure,
    FunctionCall,
    FunctionSignature,
    ImportReference
} from './types';

const ROOT_FUNCTION_TYPES: Record<string, Set<string>> = {
    typescript: new Set(['function_declaration', 'arrow_function', 'method_definition']),
    javascript: new Set(['function_declaration', 'arrow_function', 'method_definition']),
    python: new Set(['function_definition', 'async_function_definition']),
    java: new Set(['method_declaration', 'constructor_declaration']),
    go: new Set(['function_declaration', 'method_declaration']),
    rust: new Set(['function_item']),
    cpp: new Set(['function_definition']),
    csharp: new Set(['method_declaration', 'constructor_declaration'])
};

const CLASS_TYPES: Record<string, Set<string>> = {
    typescript: new Set(['class_declaration']),
    javascript: new Set(['class_declaration']),
    python: new Set(['class_definition']),
    java: new Set(['class_declaration', 'interface_declaration']),
    go: new Set(['type_declaration']),
    rust: new Set(['impl_item', 'trait_item', 'struct_item']),
    cpp: new Set(['class_specifier', 'struct_specifier']),
    csharp: new Set(['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration'])
};

const IMPORT_TYPES: Record<string, Set<string>> = {
    typescript: new Set(['import_statement']),
    javascript: new Set(['import_statement']),
    python: new Set(['import_statement', 'import_from_statement']),
    java: new Set(['import_declaration']),
    go: new Set(['import_declaration']),
    rust: new Set(['use_declaration']),
    cpp: new Set(['preproc_include']),
    csharp: new Set(['using_directive'])
};

const EXPORT_TYPES: Record<string, Set<string>> = {
    typescript: new Set(['export_statement']),
    javascript: new Set(['export_statement'])
};

const CALL_TYPES: Record<string, Set<string>> = {
    typescript: new Set(['call_expression', 'new_expression']),
    javascript: new Set(['call_expression', 'new_expression']),
    python: new Set(['call']),
    java: new Set(['method_invocation', 'object_creation_expression']),
    go: new Set(['call_expression']),
    rust: new Set(['call_expression', 'macro_invocation']),
    cpp: new Set(['call_expression']),
    csharp: new Set(['invocation_expression', 'object_creation_expression'])
};

export function analyzeFileStructure(filePath: string, content: string, workspaceRoot?: string): FileStructure | null {
    const language = detectLanguage(filePath);
    if (!language) {
        return null;
    }

    const languageModule = getTreeSitterLanguage(language);
    if (!languageModule) {
        return buildEmptyStructure(filePath, language, content);
    }

    const parser = new Parser();
    try {
        parser.setLanguage(languageModule);
    } catch {
        return buildEmptyStructure(filePath, language, content);
    }

    const tree = parseSourceSafely(parser, content);

    if (!tree) {
        return buildEmptyStructure(filePath, language, content);
    }

    const imports: ImportReference[] = [];
    const exports: ExportReference[] = [];
    const classes: ClassSignature[] = [];
    const functions: FunctionSignature[] = [];
    const docstrings: string[] = [];
    const topLevelCalls: FunctionCall[] = [];

    walk(tree.rootNode, node => {
        const type = node.type;

        if (IMPORT_TYPES[language]?.has(type)) {
            imports.push(extractImport(node, content, language, filePath, workspaceRoot));
        }

        if (EXPORT_TYPES[language]?.has(type)) {
            exports.push(...extractExports(node, content));
        }

        if (CLASS_TYPES[language]?.has(type) && isLikelyClassNode(node, language, content)) {
            classes.push(extractClass(node, content, language));
        }

        if (ROOT_FUNCTION_TYPES[language]?.has(type) && !hasClassAncestor(node, language)) {
            functions.push(extractFunction(node, content, language));
        }

        if (CALL_TYPES[language]?.has(type) && !hasFunctionOrClassAncestor(node, language)) {
            topLevelCalls.push(extractCall(node, content, language));
        }
    });

    const rootDocstring = extractDocstring(tree.rootNode, content, language);
    if (rootDocstring) {
        docstrings.push(rootDocstring);
    }

    for (const fn of functions) {
        if (fn.docstring) {
            docstrings.push(fn.docstring);
        }
    }
    for (const cls of classes) {
        if (cls.docstring) {
            docstrings.push(cls.docstring);
        }
    }

    return {
        filePath,
        language,
        imports,
        exports,
        classes,
        functions,
        docstrings: uniqueStrings(docstrings),
        topLevelCalls,
        analyzedAt: new Date().toISOString(),
        hash: hashContent(content)
    };
}

function buildEmptyStructure(filePath: string, language: string, content: string): FileStructure {
    const structure: FileStructure = {
        filePath,
        language,
        imports: [],
        exports: [],
        classes: [],
        functions: [],
        docstrings: [],
        topLevelCalls: [],
        analyzedAt: new Date().toISOString(),
        hash: hashContent(content)
    };

    if (language === 'python') {
        const funcRegex = /^[ \t]*(?:async\s+)?def\s+(\w+)/gm;
        const classRegex = /^[ \t]*class\s+(\w+)/gm;
        let match;
        
        while ((match = classRegex.exec(content)) !== null) {
            const startLine = content.substring(0, match.index).split('\n').length;
            structure.classes.push({
                name: match[1],
                startLine,
                endLine: startLine + 10,
                methods: [],
                docstring: null
            });
        }
        
        while ((match = funcRegex.exec(content)) !== null) {
            const startLine = content.substring(0, match.index).split('\n').length;
            const functionBody = content.substring(match.index, match.index + 2000); // Look ahead for calls
            const calls: FunctionCall[] = [];
            
            // Extract common Python and RepoGuide method calls
            const callRegex = /(?:self\.)?([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+)\s*\(/g;
            let callMatch;
            while ((callMatch = callRegex.exec(functionBody)) !== null) {
                const expr = callMatch[1];
                calls.push({
                    callee: normalizeCallName(expr),
                    line: startLine + 1, // approximate
                    fullExpression: expr
                });
            }

            structure.functions.push({
                name: match[1],
                kind: 'function',
                startLine,
                endLine: startLine + 20,
                calls,
                bodyPreview: ''
            });
        }
    }

    return structure;
}

function walk(node: Parser.SyntaxNode, visitor: (node: Parser.SyntaxNode) => void): void {
    visitor(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            walk(child, visitor);
        }
    }
}

function extractImport(
    node: Parser.SyntaxNode,
    content: string,
    language: string,
    filePath: string,
    workspaceRoot?: string
): ImportReference {
    const text = content.slice(node.startIndex, node.endIndex);
    const source = extractImportSource(text);
    const importedNames = uniqueStrings(
        (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
            .filter(token => !isImportNoise(token, language))
    );
    let resolvedPath: string | null = null;
    if (source.startsWith('./') || source.startsWith('../')) {
        const base = path.resolve(path.dirname(filePath), source);
        const candidates = [
            base,
            `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
            `${base}.py`, `${base}.go`, `${base}.rs`, `${base}.cpp`,
            path.join(base, 'index.ts'), path.join(base, 'index.js'),
            path.join(base, '__init__.py')
        ];
        resolvedPath = candidates.find(candidate => fs.existsSync(candidate)) ?? null;
    }

    // Python absolute import resolution
    // Handles imports like "from app.agents.base_agent import BaseAgent"
    if (!resolvedPath && language === 'python' && workspaceRoot && !source.startsWith('.')) {
        const moduleParts = source.split('.');
        const absCandidates: string[] = [];

        // Collect candidate root directories to search from:
        // 1. The workspace root itself
        // 2. Walk up from the importing file's directory to find ancestors
        //    that contain the first module part (e.g., find 'ProjectName/'
        //    because it has an 'app/' subdirectory matching the first part)
        const searchRoots: string[] = [workspaceRoot];
        const firstPart = moduleParts[0];
        let dir = path.dirname(filePath);
        const normalizedWorkspaceRoot = path.normalize(workspaceRoot).toLowerCase();
        while (dir.toLowerCase().startsWith(normalizedWorkspaceRoot) && dir.length > normalizedWorkspaceRoot.length) {
            const parentDir = path.dirname(dir);
            // Check if this ancestor contains the first module part as a subdirectory or file
            if (fs.existsSync(path.join(parentDir, firstPart)) ||
                fs.existsSync(path.join(parentDir, firstPart + '.py'))) {
                if (!searchRoots.includes(parentDir)) {
                    searchRoots.push(parentDir);
                }
            }
            dir = parentDir;
        }

        // Try progressively shorter module paths from each search root
        for (const root of searchRoots) {
            for (let len = moduleParts.length; len >= 1; len--) {
                const subPath = moduleParts.slice(0, len).join(path.sep);
                absCandidates.push(
                    path.join(root, subPath + '.py'),
                    path.join(root, subPath, '__init__.py')
                );
            }
        }
        resolvedPath = absCandidates.find(c => fs.existsSync(c)) ?? null;
    }

    return {
        source,
        importedNames,
        resolvedPath
    };
}

function extractExports(node: Parser.SyntaxNode, content: string): ExportReference[] {
    const text = content.slice(node.startIndex, node.endIndex);
    const names = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return uniqueStrings(names.filter(name => !['export', 'default'].includes(name))).map(name => ({
        name,
        kind: 'export',
        line: node.startPosition.row + 1
    }));
}

function extractClass(node: Parser.SyntaxNode, content: string, language: string): ClassSignature {
    const nameNode = node.childForFieldName('name') ?? findFirstNamed(node, ['identifier', 'type_identifier', 'name']);
    const classText = content.slice(node.startIndex, node.endIndex);
    const methods: FunctionSignature[] = [];
    walk(node, child => {
        if (child === node) {
            return;
        }
        if (ROOT_FUNCTION_TYPES[language]?.has(child.type) && hasDirectClassLikeAncestor(child, node)) {
            methods.push(extractFunction(child, content, language, true));
        }
    });

    return {
        name: nameNode ? content.slice(nameNode.startIndex, nameNode.endIndex) : 'AnonymousClass',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        docstring: extractDocstring(node, content, language),
        extendsName: extractExtendsName(classText),
        methods
    };
}

function extractFunction(
    node: Parser.SyntaxNode,
    content: string,
    language: string,
    forceMethod = false
): FunctionSignature {
    const nameNode = node.childForFieldName('name') ?? findFirstNamed(node, ['identifier', 'property_identifier', 'type_identifier']);
    const fnText = content.slice(node.startIndex, node.endIndex);
    const calls: FunctionCall[] = [];
    walk(node, child => {
        if (CALL_TYPES[language]?.has(child.type)) {
            calls.push(extractCall(child, content, language));
        }
    });

    const name = nameNode ? content.slice(nameNode.startIndex, nameNode.endIndex) : 'anonymous';
    const bodyLines = fnText.split(/\r?\n/).slice(0, 50).join('\n');

    return {
        name,
        kind: forceMethod || node.type === 'method_definition'
            ? 'method'
            : node.type === 'constructor_declaration'
                ? 'constructor'
                : 'function',
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        docstring: extractDocstring(node, content, language),
        calls: dedupeCalls(calls),
        isExported: /\bexport\b/.test(content.slice(Math.max(0, node.startIndex - 32), node.endIndex)),
        bodyPreview: bodyLines
    };
}

function extractCall(node: Parser.SyntaxNode, content: string, language: string): FunctionCall {
    const fieldName = language === 'python' ? 'function' : language === 'java' ? 'name' : 'function';
    const calleeNode =
        node.childForFieldName(fieldName) ??
        node.childForFieldName('constructor') ??
        node.child(0);
    const calleeText = calleeNode ? content.slice(calleeNode.startIndex, calleeNode.endIndex) : 'unknown';

    return {
        callee: normalizeCallName(calleeText),
        line: node.startPosition.row + 1,
        fullExpression: calleeText.trim()
    };
}

function extractDocstring(node: Parser.SyntaxNode, content: string, language: string): string | null {
    if (language === 'python') {
        const block = node.childForFieldName('body');
        if (!block || block.childCount === 0) {
            return null;
        }
        const first = block.child(0);
        if (!first) {
            return null;
        }
        const text = content.slice(first.startIndex, first.endIndex).trim();
        if ((text.startsWith('"""') && text.endsWith('"""')) || (text.startsWith("'''") && text.endsWith("'''"))) {
            return text.replace(/^['"]{3}|['"]{3}$/g, '').trim();
        }
        return null;
    }

    const lines = content.split(/\r?\n/);
    let cursor = node.startPosition.row - 1;
    const commentLines: string[] = [];

    while (cursor >= 0) {
        const rawLine = lines[cursor]?.trim();
        if (!rawLine) {
            cursor--;
            continue;
        }
        if (rawLine.startsWith('//') || rawLine.startsWith('*') || rawLine.startsWith('/*') || rawLine.startsWith('*/')) {
            commentLines.unshift(rawLine.replace(/^\/\//, '').replace(/^\/\*/, '').replace(/^\*/, '').replace(/\*\/$/, '').trim());
            cursor--;
            continue;
        }
        break;
    }

    const combined = commentLines.join(' ').trim();
    return combined.length > 0 ? combined : null;
}

function hasClassAncestor(node: Parser.SyntaxNode, language: string): boolean {
    let cursor = node.parent;
    while (cursor) {
        if (CLASS_TYPES[language]?.has(cursor.type)) {
            return true;
        }
        cursor = cursor.parent;
    }
    return false;
}

function hasFunctionOrClassAncestor(node: Parser.SyntaxNode, language: string): boolean {
    let cursor = node.parent;
    while (cursor) {
        if (ROOT_FUNCTION_TYPES[language]?.has(cursor.type) || CLASS_TYPES[language]?.has(cursor.type)) {
            return true;
        }
        cursor = cursor.parent;
    }
    return false;
}

function hasDirectClassLikeAncestor(node: Parser.SyntaxNode, classNode: Parser.SyntaxNode): boolean {
    let cursor = node.parent;
    while (cursor) {
        if (cursor === classNode) {
            return true;
        }
        cursor = cursor.parent;
    }
    return false;
}

function isLikelyClassNode(node: Parser.SyntaxNode, language: string, content: string): boolean {
    if (language !== 'go') {
        return true;
    }
    const text = content.slice(node.startIndex, node.endIndex);
    return /\bstruct\b|\binterface\b/.test(text);
}

function findFirstNamed(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && types.includes(child.type)) {
            return child;
        }
    }
    return null;
}

function extractImportSource(text: string): string {
    const quoted = text.match(/["']([^"']+)["']/);
    if (quoted) {
        return quoted[1];
    }
    const includeMatch = text.match(/<([^>]+)>/);
    if (includeMatch) {
        return includeMatch[1];
    }
    const fromMatch = text.match(/^from\s+([A-Za-z0-9_.]+)\s+import/);
    if (fromMatch) {
        return fromMatch[1];
    }
    const importMatch = text.match(/^import\s+([A-Za-z0-9_.]+)/);
    if (importMatch) {
        return importMatch[1];
    }
    const usingMatch = text.match(/^using\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/);
    if (usingMatch) {
        return usingMatch[1];
    }
    return text.trim();
}

function isImportNoise(token: string, language: string): boolean {
    const noise = new Set([
        'import', 'from', 'as', 'use', 'package', 'default', 'type', 'public',
        'class', 'struct', 'include', 'static', 'const', 'let', 'var', 'using'
    ]);
    if (noise.has(token)) {
        return true;
    }
    if (language === 'python' && token === 'import_from_statement') {
        return true;
    }
    return false;
}

function extractExtendsName(text: string): string | null {
    const match = text.match(/\b(?:extends|implements)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return match ? match[1] : null;
}

function normalizeCallName(text: string): string {
    const trimmed = text.trim().replace(/[^\w.]/g, '');
    if (!trimmed) {
        return 'unknown';
    }
    const segments = trimmed.split('.');
    return segments[segments.length - 1];
}

function dedupeCalls(calls: FunctionCall[]): FunctionCall[] {
    const seen = new Set<string>();
    return calls.filter(call => {
        const key = `${call.callee}:${call.line}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex');
}
