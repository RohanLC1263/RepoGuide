import Parser = require('node-tree-sitter');
import { getTreeSitterLanguage } from './languageDetector';
import { parseSourceSafely } from './treeSitterParse';
import { MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, textChunk } from './textChunker';
import { Logger } from '../context/repositoryContext';

const RELEVANT_NODE_TYPES: Record<string, Set<string>> = {
    'typescript': new Set(['function_declaration', 'arrow_function', 'method_definition', 'class_declaration', 'lexical_declaration', 'variable_declaration']),
    'javascript': new Set(['function_declaration', 'arrow_function', 'method_definition', 'class_declaration', 'lexical_declaration', 'variable_declaration']),
    'python': new Set(['function_definition', 'class_definition', 'async_function_definition', 'decorated_definition', 'assignment']),
    'java': new Set(['method_declaration', 'class_declaration', 'interface_declaration', 'field_declaration']),
    'go': new Set(['function_declaration', 'method_declaration', 'type_declaration', 'const_declaration', 'var_declaration']),
    'rust': new Set(['function_item', 'impl_item', 'trait_item', 'static_item', 'const_item']),
    'cpp': new Set(['function_definition', 'struct_specifier', 'class_specifier'])
};

function splitLargeAstChunk(
    filePath: string,
    text: string,
    language: string,
    startLine: number
): Array<{text: string, startLine: number, endLine: number}> {
    return textChunk(filePath, text, language).map(chunk => ({
        text: chunk.text,
        startLine: startLine + chunk.startLine,
        endLine: startLine + chunk.endLine
    }));
}

/**
 * Chunks a file using Tree-sitter AST parsing.
 * Falls back to textChunk if:
 *   - The language has no Tree-sitter grammar
 *   - setLanguage() fails
 *   - parser.parse() throws
 *   - No relevant AST nodes are found
 */
export function astChunk(filePath: string, content: string, language: string, logger?: Logger): Array<{text: string, startLine: number, endLine: number}> {
    const LanguageModule = getTreeSitterLanguage(language);
    if (!LanguageModule) {
        return textChunk(filePath, content, language);
    }
    
    // Create parser
    const parser = new Parser();
    try {
        parser.setLanguage(LanguageModule);
    } catch (e) {
        if (logger) logger.warn(`Tree-sitter setLanguage failed for ${filePath}: ${e}`);
        return textChunk(filePath, content, language);
    }

    let tree: Parser.Tree | null = parseSourceSafely(parser, content);
    if (tree && tree.rootNode.hasError) {
        tree = null;
    }

    if (!tree) {
        const chunks = textChunk(filePath, content, language);
        if (language === 'python') {
            const funcRegex = /^[ \t]*(?:async\s+)?def\s+(\w+)/gm;
            const classRegex = /^[ \t]*class\s+(\w+)/gm;
            let match;
            
            while ((match = classRegex.exec(content)) !== null) {
                const startLine = content.substring(0, match.index).split('\n').length;
                chunks.push({
                    text: `class ${match[1]}`,
                    startLine,
                    endLine: startLine + 10
                });
            }
            
            while ((match = funcRegex.exec(content)) !== null) {
                const startLine = content.substring(0, match.index).split('\n').length;
                chunks.push({
                    text: `def ${match[1]}`,
                    startLine,
                    endLine: startLine + 10
                });
            }
        }
        return chunks;
    }

    const chunks: Array<{text: string, startLine: number, endLine: number}> = [];
    
    const relevantTypes = RELEVANT_NODE_TYPES[language];
    if (!relevantTypes) {
        return textChunk(filePath, content, language);
    }

    function walk(node: Parser.SyntaxNode, depth: number) {
        const type = node.type;
        let nextDepth = depth;

        if (relevantTypes.has(type)) {
            // handle python decorated_definition
            let skip = false;
            if (language === 'python' && (type === 'function_definition' || type === 'async_function_definition' || type === 'class_definition')) {
                if (node.parent && node.parent.type === 'decorated_definition') {
                    skip = true;
                }
            }

            const isContainer = type.includes('function') || type.includes('class') || type.includes('method') || type.includes('struct') || type.includes('impl') || type.includes('trait');
            if (isContainer) {
                nextDepth++;
            }

            if (!skip) {
                const isDeclaration = type.includes('declaration') || type.includes('assignment') || type.includes('item');
                // Only chunk declarations/assignments if they are at the top level (depth === 0)
                // Container types (classes/functions) are always chunked regardless of depth
                const shouldChunk = isContainer || (isDeclaration && depth === 0);

                if (shouldChunk) {
                    const startLine = node.startPosition.row;
                    const endLine = node.endPosition.row;
                    const lineCount = endLine - startLine + 1;
                    const nodeText = content.slice(node.startIndex, node.endIndex);
                    
                    if (lineCount >= 3 && nodeText.trim().length >= MIN_CHUNK_CHARS) {
                        if (nodeText.length > MAX_CHUNK_CHARS) {
                            const isClassContainer = type === 'class_definition' ||
                                                      type === 'class_declaration';
                            if (isClassContainer) {
                                const lines = nodeText.split('\n');
                                const docChunk = lines.slice(0, 10).join('\n');
                                if (docChunk.trim().length >= MIN_CHUNK_CHARS) {
                                    chunks.push({
                                        text: docChunk,
                                        startLine: startLine,
                                        endLine: startLine + 9
                                    });
                                }
                            } else {
                                chunks.push({
                                    text: nodeText,
                                    startLine,
                                    endLine
                                });
                            }
                        } else {
                            chunks.push({
                                text: nodeText,
                                startLine,
                                endLine
                            });
                        }
                    }
                }
            }
        }
        
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                walk(child, nextDepth);
            }
        }
    }

    walk(tree.rootNode, 0);
    
    if (chunks.length === 0) {
        return textChunk(filePath, content, language);
    }
    
    return chunks;
}
