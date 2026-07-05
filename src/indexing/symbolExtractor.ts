import Parser = require('node-tree-sitter');
import { getTreeSitterLanguage } from './languageDetector';
import { parseSourceSafely } from './treeSitterParse';
import { SymbolEntry } from '../store/storeTypes';

const NODE_TYPES: Record<string, Array<{ type: string; kind: SymbolEntry['kind'] }>> = {
    typescript: [
        { type: 'class_declaration', kind: 'class' },
        { type: 'function_declaration', kind: 'function' },
        { type: 'method_definition', kind: 'method' },
        { type: 'interface_declaration', kind: 'interface' },
        { type: 'type_alias_declaration', kind: 'interface' },
        { type: 'variable_declarator', kind: 'constant' }
    ],
    javascript: [
        { type: 'class_declaration', kind: 'class' },
        { type: 'function_declaration', kind: 'function' },
        { type: 'method_definition', kind: 'method' },
        { type: 'variable_declarator', kind: 'constant' }
    ],
    python: [
        { type: 'class_definition', kind: 'class' },
        { type: 'function_definition', kind: 'function' },
        { type: 'async_function_definition', kind: 'function' },
        { type: 'assignment', kind: 'constant' }
    ],
    java: [
        { type: 'class_declaration', kind: 'class' },
        { type: 'method_declaration', kind: 'method' },
        { type: 'interface_declaration', kind: 'interface' }
    ],
    go: [
        { type: 'function_declaration', kind: 'function' },
        { type: 'method_declaration', kind: 'method' },
        { type: 'type_declaration', kind: 'class' }
    ],
    rust: [
        { type: 'function_item', kind: 'function' },
        { type: 'struct_item', kind: 'class' },
        { type: 'impl_item', kind: 'class' },
        { type: 'trait_item', kind: 'interface' }
    ],
    cpp: [
        { type: 'function_definition', kind: 'function' },
        { type: 'class_specifier', kind: 'class' },
        { type: 'struct_specifier', kind: 'class' }
    ]
};

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const RESERVED_METHOD_NAMES = new Set([
    'catch',
    'for',
    'function',
    'if',
    'return',
    'switch',
    'while'
]);

function countBraces(line: string): number {
    let depth = 0;
    for (const char of line) {
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
        }
    }
    return depth;
}

function extractTypeScriptSymbolsByRegex(filePath: string, content: string): SymbolEntry[] {
    const symbols: SymbolEntry[] = [];
    const seen = new Set<string>();
    const lines = content.split(/\r?\n/);
    let classDepth = 0;

    const addSymbol = (name: string, lineIndex: number, kind: SymbolEntry['kind']) => {
        const key = `${kind}:${name}:${lineIndex}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        symbols.push({
            name,
            filePath,
            startLine: lineIndex,
            endLine: lineIndex,
            kind
        });
    };

    const declarationPatterns: Array<{ regex: RegExp; kind: SymbolEntry['kind'] }> = [
        { regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENTIFIER})\\b`), kind: 'class' },
        { regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?interface\\s+(${IDENTIFIER})\\b`), kind: 'interface' },
        { regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?type\\s+(${IDENTIFIER})\\b\\s*=`), kind: 'interface' },
        { regex: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENTIFIER})\\b`), kind: 'function' },
        { regex: new RegExp(`^\\s*(?:export\\s+)?const\\s+(${IDENTIFIER})\\b`), kind: 'constant' },
        { regex: new RegExp(`^\\s*export\\s+const\\s+(${IDENTIFIER})\\b.*=>`), kind: 'function' }
    ];
    const methodPattern = new RegExp(
        `^\\s*(?:(?:public|private|protected|static|async|override|abstract|readonly)\\s+)*(${IDENTIFIER})\\s*(?:<[^>{}]*>)?\\s*\\(`
    );

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let beginsClass = false;

        for (const { regex, kind } of declarationPatterns) {
            const match = regex.exec(line);
            if (match) {
                addSymbol(match[1], i, kind);
                if (kind === 'class') {
                    beginsClass = true;
                }
                break;
            }
        }

        if (classDepth > 0 || beginsClass) {
            const methodMatch = methodPattern.exec(line);
            if (methodMatch) {
                const methodName = methodMatch[1];
                if (!RESERVED_METHOD_NAMES.has(methodName)) {
                    addSymbol(methodName, i, methodName === 'constructor' ? 'method' : 'method');
                }
            }
        }

        if (beginsClass && classDepth === 0) {
            classDepth = Math.max(1, countBraces(line));
        } else if (classDepth > 0) {
            classDepth = Math.max(0, classDepth + countBraces(line));
        }
    }

    return symbols;
}

export function extractSymbols(filePath: string, content: string, language: string): SymbolEntry[] {
    const LanguageModule = getTreeSitterLanguage(language);
    if (!LanguageModule) {
        return [];
    }

    const parser = new Parser();
    try {
        parser.setLanguage(LanguageModule);
    } catch (e) {
        return [];
    }

    const tree: Parser.Tree | null = parseSourceSafely(parser, content);

    const symbols: SymbolEntry[] = [];

    if (!tree) {
        if (language === 'typescript' || language === 'javascript') {
            return extractTypeScriptSymbolsByRegex(filePath, content);
        }
        if (language === 'python') {
            const funcRegex = /^[ \t]*(?:async\s+)?def\s+(\w+)/gm;
            const classRegex = /^[ \t]*class\s+(\w+)/gm;
            const constRegex = /^[ \t]*([A-Z][A-Z0-9_]+)\s*=/gm;
            let match;
            
            while ((match = classRegex.exec(content)) !== null) {
                symbols.push({
                    name: match[1],
                    filePath,
                    startLine: content.substring(0, match.index).split('\n').length,
                    endLine: content.substring(0, match.index).split('\n').length + 10,
                    kind: 'class'
                });
            }
            
            while ((match = funcRegex.exec(content)) !== null) {
                symbols.push({
                    name: match[1],
                    filePath,
                    startLine: content.substring(0, match.index).split('\n').length,
                    endLine: content.substring(0, match.index).split('\n').length + 10,
                    kind: 'function'
                });
            }

            while ((match = constRegex.exec(content)) !== null) {
                symbols.push({
                    name: match[1],
                    filePath,
                    startLine: content.substring(0, match.index).split('\n').length,
                    endLine: content.substring(0, match.index).split('\n').length,
                    kind: 'constant'
                });
            }
        }
        return symbols;
    }
    const languageMappings = NODE_TYPES[language] ?? [];
    const nodeKindMap = new Map(languageMappings.map(entry => [entry.type, entry.kind]));

    function getIdentifierName(node: Parser.SyntaxNode): string | null {
        const directName = node.childForFieldName('name');
        if (directName?.text) {
            return directName.text;
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child.type === 'identifier' || child.type === 'type_identifier')) {
                return child.text;
            }
        }

        return null;
    }

    function processNode(node: Parser.SyntaxNode) {
        const type = node.type;
        let name = getIdentifierName(node);
        let kind = nodeKindMap.get(type) ?? null;

        if (type === 'arrow_function' && node.parent && node.parent.type === 'variable_declarator') {
            const declName = node.parent.childForFieldName('name');
            if (declName) {
                name = declName.text;
                kind = 'function';
            }
        }

        if (type === 'type_declaration' && language === 'go') {
            const typeSpec = node.children.find(ch => ch.type === 'type_spec');
            if (typeSpec) {
                const tsName = typeSpec.childForFieldName('name');
                if (tsName) {
                    name = tsName.text;
                    const typeType = typeSpec.childForFieldName('type');
                    if (typeType && typeType.type === 'struct_type') {
                        kind = 'class';
                    } else if (typeType && typeType.type === 'interface_type') {
                        kind = 'interface';
                    }
                }
            }
        }

        // Instantiation detection
        if (type === 'new_expression') { // JS/TS/Java/CPP
            const className = getIdentifierName(node);
            if (className) {
                name = className;
                kind = 'instantiation';
            }
        } else if (type === 'call' && language === 'python') {
            const funcNode = node.childForFieldName('function');
            if (funcNode && funcNode.type === 'identifier') {
                const funcName = funcNode.text;
                // Heuristic: if it starts with an uppercase letter, it's likely a class instantiation
                if (funcName.length > 0 && funcName[0] >= 'A' && funcName[0] <= 'Z') {
                    name = funcName;
                    kind = 'instantiation';
                }
            }
        }

        if (name && kind) {
            symbols.push({
                name,
                filePath,
                startLine: node.startPosition.row,
                endLine: node.endPosition.row,
                kind
            });
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                processNode(child);
            }
        }
    }

    try {
        processNode(tree.rootNode);
    } catch (e) {
        // fail silently on AST walking errors
    }

    return symbols;
}
