import * as fs from 'fs';
import * as path from 'path';
import {
    ClassSignature,
    ExportReference,
    FileStructure,
    FunctionSignature,
    LexicalComment,
    LexicalFileEntry,
    LexicalMap,
    LexicalSymbol,
    LexicalSymbolKind
} from './types';

export function buildLexicalMap(
    projectRoot: string,
    fileStructures: FileStructure[]
): LexicalMap {
    const files: Record<string, LexicalFileEntry> = Object.create(null);
    const symbolsByName: Record<string, string[]> = Object.create(null);
    const stats = {
        files: fileStructures.length,
        symbols: 0,
        functions: 0,
        classes: 0,
        methods: 0,
        exports: 0,
        comments: 0
    };

    for (const structure of fileStructures) {
        const content = readFileContent(structure.filePath);
        const comments = extractComments(structure.filePath, structure.language, content);
        const symbols = buildFileSymbols(structure, comments);

        for (const symbol of symbols) {
            const existing = symbolsByName[symbol.name] ?? [];
            existing.push(symbol.id);
            symbolsByName[symbol.name] = existing;

            stats.symbols += 1;
            if (symbol.kind === 'function') {
                stats.functions += 1;
            } else if (symbol.kind === 'class') {
                stats.classes += 1;
            } else if (symbol.kind === 'method' || symbol.kind === 'constructor') {
                stats.methods += 1;
            } else if (symbol.kind === 'export') {
                stats.exports += 1;
            }
        }

        stats.comments += comments.length;
        files[path.normalize(structure.filePath)] = {
            filePath: path.normalize(structure.filePath),
            language: structure.language,
            hash: structure.hash,
            updatedAt: new Date().toISOString(),
            symbols,
            comments,
            docstrings: structure.docstrings
        };
    }

    return {
        version: '1.0',
        builtAt: new Date().toISOString(),
        projectRoot,
        fileCount: fileStructures.length,
        files,
        symbolsByName,
        stats,
        confidence: 1.0
    };
}

function buildFileSymbols(
    structure: FileStructure,
    comments: LexicalComment[]
): LexicalSymbol[] {
    const symbols: LexicalSymbol[] = [];

    for (const fn of structure.functions) {
        symbols.push(symbolFromFunction(structure, fn, fn.kind, comments));
    }

    for (const cls of structure.classes) {
        symbols.push(symbolFromClass(structure, cls, comments));
        for (const method of cls.methods) {
            symbols.push(symbolFromFunction(
                structure,
                method,
                method.kind === 'constructor' ? 'constructor' : 'method',
                comments,
                cls.name
            ));
        }
    }

    for (const exp of structure.exports) {
        symbols.push(symbolFromExport(structure, exp, comments));
    }

    return dedupeSymbols(symbols);
}

function symbolFromClass(
    structure: FileStructure,
    cls: ClassSignature,
    comments: LexicalComment[]
): LexicalSymbol {
    return {
        id: symbolId(structure.filePath, 'class', cls.name, cls.startLine),
        name: cls.name,
        kind: 'class',
        filePath: path.normalize(structure.filePath),
        language: structure.language,
        startLine: cls.startLine,
        endLine: cls.endLine,
        isExported: isExportedName(structure.exports, cls.name),
        docstring: cls.docstring ?? null,
        leadingComments: getLeadingComments(comments, cls.startLine),
        confidence: 1.0
    };
}

function symbolFromFunction(
    structure: FileStructure,
    fn: FunctionSignature,
    kind: LexicalSymbolKind,
    comments: LexicalComment[],
    containerName?: string
): LexicalSymbol {
    return {
        id: symbolId(structure.filePath, kind, containerName ? `${containerName}.${fn.name}` : fn.name, fn.startLine),
        name: fn.name,
        kind,
        filePath: path.normalize(structure.filePath),
        language: structure.language,
        startLine: fn.startLine,
        endLine: fn.endLine,
        containerName,
        isExported: Boolean(fn.isExported) || isExportedName(structure.exports, fn.name),
        docstring: fn.docstring ?? null,
        leadingComments: getLeadingComments(comments, fn.startLine),
        confidence: 1.0
    };
}

function symbolFromExport(
    structure: FileStructure,
    exp: ExportReference,
    comments: LexicalComment[]
): LexicalSymbol {
    return {
        id: symbolId(structure.filePath, 'export', exp.name, exp.line),
        name: exp.name,
        kind: 'export',
        filePath: path.normalize(structure.filePath),
        language: structure.language,
        startLine: exp.line,
        endLine: exp.line,
        isExported: true,
        docstring: null,
        leadingComments: getLeadingComments(comments, exp.line),
        confidence: 1.0
    };
}

function extractComments(filePath: string, language: string, content: string): LexicalComment[] {
    if (!content) {
        return [];
    }

    const comments: LexicalComment[] = [];
    const lines = content.split(/\r?\n/);
    let blockStartLine: number | null = null;
    let blockLines: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        const trimmed = lines[index].trim();

        if (blockStartLine !== null) {
            blockLines.push(trimmed.replace(/\*\/$/, '').replace(/^\*/, '').trim());
            if (trimmed.includes('*/')) {
                comments.push({
                    filePath: path.normalize(filePath),
                    startLine: blockStartLine,
                    endLine: lineNumber,
                    text: cleanCommentText(blockLines.join('\n')),
                    kind: 'block'
                });
                blockStartLine = null;
                blockLines = [];
            }
            continue;
        }

        if (trimmed.startsWith('/*')) {
            blockStartLine = lineNumber;
            blockLines = [trimmed.replace(/^\/\*/, '').replace(/\*\/$/, '').trim()];
            if (trimmed.includes('*/')) {
                comments.push({
                    filePath: path.normalize(filePath),
                    startLine: lineNumber,
                    endLine: lineNumber,
                    text: cleanCommentText(blockLines.join('\n')),
                    kind: 'block'
                });
                blockStartLine = null;
                blockLines = [];
            }
            continue;
        }

        if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
            comments.push({
                filePath: path.normalize(filePath),
                startLine: lineNumber,
                endLine: lineNumber,
                text: cleanCommentText(trimmed.replace(/^\/\//, '').replace(/^#/, '')),
                kind: 'line'
            });
            continue;
        }

        if (language === 'python' && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
            const quote = trimmed.startsWith('"""') ? '"""' : "'''";
            const docLines = [trimmed.replace(quote, '').replace(quote, '')];
            let endLine = lineNumber;
            if (!trimmed.endsWith(quote) || trimmed === quote) {
                for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
                    endLine = cursor + 1;
                    const docLine = lines[cursor].trim();
                    docLines.push(docLine.replace(quote, ''));
                    if (docLine.endsWith(quote)) {
                        break;
                    }
                }
            }
            comments.push({
                filePath: path.normalize(filePath),
                startLine: lineNumber,
                endLine,
                text: cleanCommentText(docLines.join('\n')),
                kind: 'docstring'
            });
        }
    }

    return comments.filter(comment => comment.text.length > 0);
}

function getLeadingComments(comments: LexicalComment[], symbolStartLine: number): LexicalComment[] {
    const leading: LexicalComment[] = [];
    let expectedEndLine = symbolStartLine - 1;

    for (let index = comments.length - 1; index >= 0; index -= 1) {
        const comment = comments[index];
        if (comment.endLine === expectedEndLine || comment.endLine === expectedEndLine - 1) {
            leading.unshift(comment);
            expectedEndLine = comment.startLine - 1;
            continue;
        }
        if (comment.endLine < expectedEndLine - 1) {
            break;
        }
    }

    return leading;
}

function isExportedName(exports: ExportReference[], name: string): boolean {
    return exports.some(exp => exp.name === name);
}

function symbolId(filePath: string, kind: string, name: string, startLine: number): string {
    return `${path.normalize(filePath)}:${kind}:${name}:${startLine}`;
}

function dedupeSymbols(symbols: LexicalSymbol[]): LexicalSymbol[] {
    const seen = new Set<string>();
    return symbols.filter(symbol => {
        if (seen.has(symbol.id)) {
            return false;
        }
        seen.add(symbol.id);
        return true;
    });
}

function cleanCommentText(text: string): string {
    return text
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*\*\s?/, '').trim())
        .join('\n')
        .trim();
}

function readFileContent(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}
