import Parser = require('node-tree-sitter');
import * as crypto from 'crypto';
import { LogicalUnit } from './logicalUnitTypes';
import { FactRecord, FactType, FactValueKind } from './factTypes';
import { detectLanguage, getTreeSitterLanguage } from './languageDetector';

export function extractFacts(unit: LogicalUnit): FactRecord[] {
    const facts: FactRecord[] = [];
    const language = detectLanguage(unit.filePath);
    if (!language) return facts;

    const languageModule = getTreeSitterLanguage(language);
    if (!languageModule) return facts;

    const parser = new Parser();
    parser.setLanguage(languageModule);
    let tree: Parser.Tree;
    try {
        tree = parser.parse(unit.content);
    } catch {
        extractFactsRegex(unit, language, facts);
        return dedupeFacts(facts);
    }

    const walk = (node: Parser.SyntaxNode) => {
        extractFromNode(node, unit, language, facts);
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) walk(child);
        }
    };
    walk(tree.rootNode);

    // Regex fallback
    extractFactsRegex(unit, language, facts);

    return dedupeFacts(facts);
}

function extractFactsRegex(unit: LogicalUnit, language: string, facts: FactRecord[]) {
    const content = unit.content;
    let regex: RegExp | undefined;
    if (language === 'python') {
        regex = /([\w.]+)\s*=\s*([A-Z]\w*)\s*\(/g;
    } else if (language === 'typescript' || language === 'javascript') {
        regex = /(?:const\s+|let\s+|var\s+|this\.)([\w.]+)\s*=\s*new\s+([\w.]+)\s*\(/g;
    }

    if (regex) {
        let match;
        while ((match = regex.exec(content)) !== null) {
            const varName = match[1];
            const className = match[2];
            
            // Calculate a rough line number
            const linesBefore = content.substring(0, match.index).split('\n');
            const localLine = linesBefore.length - 1;
            const startLine = unit.startLine + localLine;
            
            const factId = crypto.createHash('md5')
                .update(`${unit.id}:instantiation:${startLine}:${startLine}:${JSON.stringify({ instantiatedClass: className, args: [] })}`)
                .digest('hex');
                
            facts.push({
                factId,
                filePath: unit.filePath,
                unitId: unit.id,
                symbol: varName,
                factType: 'instantiation',
                value: { instantiatedClass: className, args: [] },
                valueKind: 'ast_node',
                startLine,
                endLine: startLine,
                extractionMethod: 'tree_sitter', // to match the schema
                confidence: 'medium',
                sourceText: match[0],
                role: unit.role
            });
        }
    }
}

function extractFromNode(node: Parser.SyntaxNode, unit: LogicalUnit, language: string, facts: FactRecord[]) {
    // Assignments and Variable Declarations
    if (language === 'python' && node.type === 'assignment') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right) {
            const varName = nodeText(left, unit.content);
            emitValueFacts(right, varName, unit, language, facts, 'assignment');
        }
    } else if ((language === 'typescript' || language === 'javascript') && (node.type === 'variable_declarator' || node.type === 'assignment_expression')) {
        const left = node.childForFieldName('name') || node.childForFieldName('left');
        const right = node.childForFieldName('value') || node.childForFieldName('right');
        if (left && right) {
            const varName = nodeText(left, unit.content);
            emitValueFacts(right, varName, unit, language, facts, 'assignment');
        }
    } else if ((language === 'typescript' || language === 'javascript') && node.type === 'pair') {
        // Object property key-value pairs, e.g. { timeout: 0, adapter: ['xhr', 'http', 'fetch'] }
        const key = node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (key && value) {
            const propName = nodeText(key, unit.content);
            emitValueFacts(value, propName, unit, language, facts, 'assignment');
        }
    }

    // Call sites (Instantiation / Env Var / Generic calls)
    if (node.type === 'call_expression' || node.type === 'new_expression' || node.type === 'call') {
        const callee = node.childForFieldName('function') || node.childForFieldName('constructor') || node.child(0);
        if (callee) {
            const calleeText = nodeText(callee, unit.content);
            
            // Env vars
            if (calleeText === 'os.environ.get' || calleeText === 'os.getenv') {
                const args = node.childForFieldName('arguments');
                if (args && args.childCount > 1) {
                    const firstArg = args.child(1); // skip `(`
                    if (firstArg && (firstArg.type === 'string' || firstArg.type === 'string_literal')) {
                        const envName = extractStringLiteral(firstArg, unit.content);
                        if (envName) {
                            addFact(facts, unit, node, 'environment_variable', envName, 'string', 'high');
                        }
                    }
                }
            }

            // Call site
            addFact(facts, unit, node, 'call_site', calleeText, 'string', 'high');
            
            if (callee.type === 'member_expression' || callee.type === 'attribute') {
                const objectNode = callee.childForFieldName('object') || callee.child(0);
                const propertyNode = callee.childForFieldName('property') || callee.child(2);
                if (objectNode && propertyNode) {
                    const objectText = nodeText(objectNode, unit.content);
                    const propertyText = nodeText(propertyNode, unit.content);
                    addFact(facts, unit, node, 'calls_method', `${objectText}.${propertyText}`, 'string', 'high');
                }
            }
        }
    }

    // TS/JS Member expressions (process.env.X)
    if (node.type === 'member_expression') {
        const objectNode = node.childForFieldName('object');
        const propertyNode = node.childForFieldName('property');
        if (objectNode && propertyNode) {
            const objectText = nodeText(objectNode, unit.content);
            if (objectText === 'process.env') {
                const envName = nodeText(propertyNode, unit.content);
                addFact(facts, unit, node, 'environment_variable', envName, 'string', 'high');
            }
        }
    }

    // Try/Catch/Except/Finally/Guards/Fallbacks
    if (node.type === 'try_statement') {
        const chain = ['try'];
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child.type === 'except_clause' || child.type === 'catch_clause')) chain.push('catch');
            if (child && child.type === 'finally_clause') chain.push('finally');
        }
        if (chain.length > 1) {
            addFact(facts, unit, node, 'fallback_chain', chain, 'list', 'high');
        }
    }
    
    // Binary coalescing/or
    if (node.type === 'binary_expression' && language !== 'python') {
        const operator = node.childForFieldName('operator');
        if (operator) {
            const opText = nodeText(operator, unit.content);
            if (opText === '??' || opText === '||') {
                const left = nodeText(node.childForFieldName('left')!, unit.content);
                const right = nodeText(node.childForFieldName('right')!, unit.content);
                addFact(facts, unit, node, 'fallback_chain', [left, right], 'list', 'high');
            }
        }
    } else if (node.type === 'boolean_operator' && language === 'python') {
        const opText = nodeText(node.child(1)!, unit.content);
        if (opText === 'or') {
            const left = nodeText(node.child(0)!, unit.content);
            const right = nodeText(node.child(2)!, unit.content);
            addFact(facts, unit, node, 'fallback_chain', [left, right], 'list', 'high');
        }
    }

    // Imports
    if (node.type === 'import_statement' || node.type === 'import_declaration' || node.type === 'import_from_statement') {
        addFact(facts, unit, node, 'import', nodeText(node, unit.content), 'string', 'high');
    }

    // Exports
    if (node.type === 'export_statement') {
        addFact(facts, unit, node, 'exported_symbol', nodeText(node, unit.content), 'string', 'high');
    }

    // Interfaces / Inheritance
    if (node.type === 'class_declaration' || node.type === 'class_definition' || node.type === 'class' || node.type === 'interface_declaration') {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child.type === 'implements_clause' || child.type === 'extends_clause' || child.type === 'class_heritage')) {
                for (let j = 0; j < child.childCount; j++) {
                    const typeId = child.child(j);
                    if (typeId && typeId.isNamed && typeId.type !== 'extends' && typeId.type !== 'implements') {
                        addFact(facts, unit, typeId, 'implements_interface', nodeText(typeId, unit.content), 'string', 'high');
                    }
                }
            }
        }
        // Python superclasses
        const superclasses = node.childForFieldName('superclasses');
        if (superclasses) {
            for (let i = 0; i < superclasses.childCount; i++) {
                const child = superclasses.child(i);
                if (child && child.isNamed) {
                    addFact(facts, unit, child, 'implements_interface', nodeText(child, unit.content), 'string', 'high');
                }
            }
        }
    }

    // Guard clauses (if statement with return/throw)
    if (node.type === 'if_statement') {
        const consequence = node.childForFieldName('consequence');
        if (consequence) {
            const consText = nodeText(consequence, unit.content);
            if (consText.includes('return') || consText.includes('throw') || consText.includes('raise')) {
                const condition = node.childForFieldName('condition');
                if (condition) {
                    addFact(facts, unit, node, 'guard_clause', nodeText(condition, unit.content), 'string', 'high');
                }
            }
        }
    }

    // Dependency injection (constructors)
    if (node.type === 'constructor_declaration' || (node.type === 'method_definition' && node.childForFieldName('name') && nodeText(node.childForFieldName('name')!, unit.content) === 'constructor')) {
        const className = unit.metadata?.className || unit.parentSymbol || unit.symbol;
        const params = node.childForFieldName('parameters');
        if (params) {
            for (let i = 0; i < params.childCount; i++) {
                const p = params.child(i);
                if (p && (p.type === 'required_parameter' || p.type === 'optional_parameter' || p.type === 'formal_parameter')) {
                    addFact(facts, unit, p, 'dependency_injection', nodeText(p, unit.content), 'string', 'high', className);
                }
            }
        }
    } else if (language === 'python' && node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nodeText(nameNode, unit.content) === '__init__') {
            const params = node.childForFieldName('parameters');
            if (params) {
                for (let i = 0; i < params.childCount; i++) {
                    const p = params.child(i);
                    if (p && p.type === 'identifier' && nodeText(p, unit.content) !== 'self') {
                        addFact(facts, unit, p, 'dependency_injection', nodeText(p, unit.content), 'string', 'high');
                    }
                }
            }
        }
    }
}

function emitValueFacts(node: Parser.SyntaxNode, varName: string, unit: LogicalUnit, language: string, facts: FactRecord[], factTypePrefix: string) {
    const isConst = varName.toUpperCase() === varName;
    const isPrompt = /prompt|template|instruction/i.test(varName);

    // Number
    if (node.type === 'number' || node.type === 'integer' || node.type === 'float') {
        const valStr = nodeText(node, unit.content);
        const num = parseFloat(valStr);
        if (!isNaN(num)) {
            addFact(facts, unit, node, 'numeric_threshold', num, 'number', 'high', varName);
            if (isConst) addFact(facts, unit, node, 'constant', num, 'number', 'high', varName);
        }
    }

    // String
    if (node.type === 'string' || node.type === 'template_string') {
        const strVal = extractStringLiteral(node, unit.content);
        addFact(facts, unit, node, 'string_literal', strVal, 'string', 'high', varName);
        if (isConst) addFact(facts, unit, node, 'constant', strVal, 'string', 'high', varName);
        if (isPrompt || node.type === 'template_string' || (node.type === 'string' && strVal.includes('\n'))) {
            addFact(facts, unit, node, 'prompt_template', strVal, 'string', 'high', varName);
        }
    }

    // List/Array
    if (node.type === 'array' || node.type === 'list') {
        const elements = node.namedChildren;
        addFact(facts, unit, node, 'list_literal', nodeText(node, unit.content), 'ast_node', 'high', varName);
        addFact(facts, unit, node, 'list_count', elements.length, 'number', 'high', varName);
        if (isConst) addFact(facts, unit, node, 'constant', nodeText(node, unit.content), 'ast_node', 'high', varName);
    }

    // Dict/Object
    if (node.type === 'object' || node.type === 'dictionary') {
        addFact(facts, unit, node, 'dict_literal', nodeText(node, unit.content), 'ast_node', 'high', varName);
        if (isConst) addFact(facts, unit, node, 'constant', nodeText(node, unit.content), 'ast_node', 'high', varName);
    }

    // Instantiation (AST)
    if (node.type === 'call_expression' || node.type === 'new_expression' || node.type === 'call') {
        const callee = node.childForFieldName('function') || node.childForFieldName('constructor') || node.child(0);
        if (callee) {
            const calleeText = nodeText(callee, unit.content);
            if (node.type === 'new_expression' || (language === 'python' && /^[A-Z][a-zA-Z0-9_]*$/.test(calleeText.split('.').pop() || ''))) {
                const argsNode = node.childForFieldName('arguments');
                const args: string[] = [];
                if (argsNode) {
                    for (let i = 0; i < argsNode.childCount; i++) {
                        const child = argsNode.child(i);
                        if (child && child.isNamed) {
                            args.push(nodeText(child, unit.content));
                        }
                    }
                }
                addFact(facts, unit, node, 'instantiation', { instantiatedClass: calleeText, args }, 'ast_node', 'high', varName);
            }
        }
    }

    addFact(facts, unit, node, 'assignment', nodeText(node, unit.content), 'ast_node', 'high', varName);
}

function nodeText(node: Parser.SyntaxNode, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
}

function extractStringLiteral(node: Parser.SyntaxNode, content: string): string {
    const raw = nodeText(node, content);
    if (raw.startsWith('"""') || raw.startsWith("'''")) return raw.slice(3, -3);
    if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith('`')) return raw.slice(1, -1);
    return raw;
}

function addFact(
    facts: FactRecord[],
    unit: LogicalUnit,
    node: Parser.SyntaxNode,
    factType: FactType,
    value: unknown,
    valueKind: FactValueKind,
    confidence: 'high' | 'medium' | 'low',
    symbol?: string
) {
    const startLine = unit.startLine + node.startPosition.row;
    const endLine = unit.startLine + node.endPosition.row;
    const sourceText = nodeText(node, unit.content);
    
    // Create deterministic ID based on exact span and type to avoid dupes across overlap
    const factId = crypto.createHash('md5')
        .update(`${unit.id}:${factType}:${startLine}:${endLine}:${JSON.stringify(value)}`)
        .digest('hex');

    facts.push({
        factId,
        filePath: unit.filePath,
        unitId: unit.id,
        symbol: symbol || unit.symbol,
        factType,
        value,
        valueKind,
        startLine,
        endLine,
        extractionMethod: 'tree_sitter',
        confidence,
        sourceText,
        role: unit.role
    });
}

function dedupeFacts(facts: FactRecord[]): FactRecord[] {
    const seen = new Set<string>();
    return facts.filter(f => {
        if (seen.has(f.factId)) return false;
        seen.add(f.factId);
        return true;
    });
}
