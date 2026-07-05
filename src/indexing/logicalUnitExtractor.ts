import * as fs from 'fs/promises';
import * as path from 'path';
import Parser = require('node-tree-sitter');
import { classifyFileRole } from './fileRoleClassifier';
import { detectLanguage, getTreeSitterLanguage } from './languageDetector';
import { parseSourceSafely } from './treeSitterParse';
import {
    LogicalUnit,
    LogicalUnitExtractionMethod,
    LogicalUnitMetadata,
    LogicalUnitParseStatus,
    LogicalUnitRole,
    LogicalUnitType
} from './logicalUnitTypes';

const PROMPT_NAME_PATTERN = /(prompt|system|template|instruction|full_prompt|system_prompt|user_prompt|chat_template)/i;
const CONFIG_PATTERN = /\b(?:os\.getenv|os\.environ\.get|dotenv)\s*\(/;
const JS_CONFIG_PATTERN = /\b(?:process\.env|dotenv(?:\.config)?\s*\()/;
const PYTHON_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_LANGUAGES_WITH_GENERIC_REGEX = new Set([
    'ruby',
    'go',
    'java',
    'rust',
    'cpp',
    'php',
    'csharp',
    'swift'
]);

type SyntaxNode = Parser.SyntaxNode;

interface UnitBuildOptions {
    type: LogicalUnitType;
    symbol?: string;
    filePath: string;
    language: string;
    content: string;
    startLine: number;
    endLine: number;
    role: LogicalUnitRole;
    parseStatus: LogicalUnitParseStatus;
    extractionMethod: LogicalUnitExtractionMethod;
    metadata?: Partial<LogicalUnitMetadata>;
    parentUnitId?: string;
    parentSymbol?: string;
}

export function extractLogicalUnits(filePath: string, content: string, language: string): LogicalUnit[] {
    try {
        const normalizedFilePath = normalizeRepoPath(filePath);
        
        // Check exclusion rules BEFORE parsing
        const lowerPath = normalizedFilePath.toLowerCase();
        if (
            lowerPath.endsWith('.min.js') ||
            lowerPath.includes('/dist/') ||
            lowerPath.includes('/build/') ||
            lowerPath.includes('eval_repos/yarn/')
        ) {
            return [];
        }

        const role = classifyFileRole(normalizedFilePath, content);
        if (role === 'generated' || content.length === 0 || looksBinary(content)) {
            return [];
        }

        if (isNonSourceRole(role)) {
            return extractUsefulNonSourceUnits(normalizedFilePath, content, language, role);
        }

        if (!['python', 'typescript', 'javascript'].includes(language)) {
            return SOURCE_LANGUAGES_WITH_GENERIC_REGEX.has(language)
                ? extractUnsupportedSourceWithRegex(normalizedFilePath, content, language, role)
                : wholeFileFallback(normalizedFilePath, content, language, role);
        }

        const languageModule = getTreeSitterLanguage(language);
        if (!languageModule) {
            return language === 'python'
                ? extractPythonWithRegex(normalizedFilePath, content, language, role)
                : extractTsJsWithRegex(normalizedFilePath, content, language, role);
        }

        const parser = new Parser();
        try {
            parser.setLanguage(languageModule);
        } catch {
            return language === 'python'
                ? extractPythonWithRegex(normalizedFilePath, content, language, role)
                : extractTsJsWithRegex(normalizedFilePath, content, language, role);
        }

        const tree = parseSourceSafely(parser, content);
        if (!tree) {
            return language === 'python'
                ? extractPythonWithRegex(normalizedFilePath, content, language, role)
                : extractTsJsWithRegex(normalizedFilePath, content, language, role);
        }

        const parseStatus: LogicalUnitParseStatus = tree.rootNode.hasError ? 'partial' : 'complete';
        const units = language === 'python'
            ? extractPythonTreeUnits(normalizedFilePath, content, language, role, tree.rootNode, parseStatus)
            : extractTsJsTreeUnits(normalizedFilePath, content, language, role, tree.rootNode, parseStatus);
        if (units.length === 0) {
            return wholeFileFallback(normalizedFilePath, content, language, role);
        }
        return sortAndDedupeUnits(units);
    } catch {
        const normalizedFilePath = normalizeRepoPath(filePath);
        const role = classifyFileRole(normalizedFilePath, content);
        return wholeFileFallback(normalizedFilePath, content, language, role);
    }
}

export async function extractLogicalUnitsFromFile(
    filePath: string,
    repoRoot: string
): Promise<LogicalUnit[]> {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedFile = path.resolve(resolvedRoot, filePath);
    if (!isInsideDirectory(resolvedFile, resolvedRoot)) {
        return [];
    }

    let content: string;
    try {
        content = await fs.readFile(resolvedFile, 'utf8');
    } catch {
        return [];
    }

    const relativePath = normalizeRepoPath(path.relative(resolvedRoot, resolvedFile));
    const language = detectLanguage(relativePath);
    if (!language) {
        return [];
    }
    return extractLogicalUnits(relativePath, content, language);
}

function extractPythonTreeUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    rootNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const units: LogicalUnit[] = [];
    const topLevelNodes = namedChildren(rootNode);

    const importBlock = extractInitialImportBlock(filePath, content, language, role, topLevelNodes, parseStatus);
    if (importBlock) {
        units.push(importBlock);
    }

    units.push(...extractPythonConstantBlocks(filePath, content, language, role, topLevelNodes, parseStatus));

    for (const node of topLevelNodes) {
        const definition = unwrapDecoratedDefinition(node);
        if (!definition) {
            continue;
        }
        if (isPythonFunctionNode(definition)) {
            units.push(...buildPythonFunctionAndBranchUnits(filePath, content, language, role, node, definition, parseStatus));
            continue;
        }
        if (definition.type === 'class_definition') {
            units.push(buildPythonClassUnit(filePath, content, language, role, node, definition, parseStatus));
            units.push(...extractPythonMethodUnits(filePath, content, language, role, definition, parseStatus));
        }
    }

    units.push(...extractPythonPromptUnits(filePath, content, language, role, topLevelNodes, parseStatus));
    units.push(...extractPythonConfigUnits(filePath, content, language, role, topLevelNodes, parseStatus));

    return units;
}

function extractInitialImportBlock(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit | undefined {
    const imports: SyntaxNode[] = [];
    for (const node of topLevelNodes) {
        if (node.type === 'comment') {
            continue;
        }
        if (node.type === 'import_statement' || node.type === 'import_from_statement') {
            imports.push(node);
            continue;
        }
        if (imports.length === 0 && node.type === 'expression_statement' && isStringExpression(content.slice(node.startIndex, node.endIndex))) {
            continue;
        }
        break;
    }

    if (imports.length === 0) {
        return undefined;
    }
    const first = imports[0];
    const last = imports[imports.length - 1];
    const text = content.slice(first.startIndex, last.endIndex);
    return buildUnit({
        type: 'import_block',
        filePath,
        language,
        content: text,
        startLine: first.startPosition.row + 1,
        endLine: last.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        metadata: {
            confidence: 'high',
            readsSymbols: extractImportSymbols(text)
        }
    });
}

function extractPythonConstantBlocks(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const assignments = topLevelNodes.filter(isTopLevelAssignment);
    const groups: SyntaxNode[][] = [];
    let current: SyntaxNode[] = [];

    for (const assignment of assignments) {
        const previous = current[current.length - 1];
        if (previous && assignment.startPosition.row + 1 - (previous.endPosition.row + 1) - 1 > 1) {
            groups.push(current);
            current = [];
        }
        current.push(assignment);
    }
    if (current.length > 0) {
        groups.push(current);
    }

    return groups.map(group => {
        const first = group[0];
        const last = group[group.length - 1];
        const text = content.slice(first.startIndex, last.endIndex);
        const symbols = uniqueStrings(group.flatMap(node => extractAssignedNames(node, content)));
        return buildUnit({
            type: 'constant_block',
            symbol: symbols[0],
            filePath,
            language,
            content: text,
            startLine: first.startPosition.row + 1,
            endLine: last.endPosition.row + 1,
            role,
            parseStatus,
            extractionMethod: 'tree_sitter',
            metadata: {
                confidence: 'high',
                readsSymbols: symbols,
                writesSymbols: symbols,
                valuePreview: previewValue(text)
            }
        });
    });
}

function extractPythonPromptUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    return topLevelNodes
        .filter(isTopLevelAssignment)
        .filter(node => extractAssignedNames(node, content).some(name => PROMPT_NAME_PATTERN.test(name)))
        .filter(node => assignmentHasStringValue(node, content))
        .map(node => {
            const names = extractAssignedNames(node, content);
            const text = content.slice(node.startIndex, node.endIndex);
            return buildUnit({
                type: 'prompt_template',
                symbol: names[0],
                filePath,
                language,
                content: text,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                role,
                parseStatus,
                extractionMethod: 'tree_sitter',
                metadata: {
                    confidence: 'high',
                    readsSymbols: names,
                    writesSymbols: names,
                    valuePreview: previewValue(text)
                }
            });
        });
}

function extractPythonConfigUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const configNodes: Array<{node: SyntaxNode; className?: string}> = [];

    for (const node of topLevelNodes) {
        if (isTopLevelAssignment(node) && CONFIG_PATTERN.test(content.slice(node.startIndex, node.endIndex))) {
            configNodes.push({ node });
            continue;
        }

        const definition = unwrapDecoratedDefinition(node);
        if (definition?.type === 'class_definition' && isBaseSettingsClass(definition, content)) {
            const className = extractNodeName(definition, content);
            for (const child of classBodyChildren(definition)) {
                if (isTopLevelAssignment(child)) {
                    configNodes.push({ node: child, className });
                }
            }
        }
    }

    return configNodes.map(({ node, className }) => {
        const names = extractAssignedNames(node, content);
        const text = content.slice(node.startIndex, node.endIndex);
        return buildUnit({
            type: 'config_block',
            symbol: names[0],
            filePath,
            language,
            content: text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            role,
            parseStatus,
            extractionMethod: 'tree_sitter',
            parentSymbol: className,
            metadata: {
                confidence: 'high',
                className,
                readsSymbols: names,
                writesSymbols: names,
                valuePreview: previewValue(text)
            }
        });
    });
}

function extractPythonMethodUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    classNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const className = extractNodeName(classNode, content);
    return classBodyChildren(classNode)
        .map(node => ({ wrapper: node, definition: unwrapDecoratedDefinition(node) }))
        .filter((item): item is {wrapper: SyntaxNode; definition: SyntaxNode} => Boolean(item.definition && isPythonFunctionNode(item.definition)))
        .flatMap(({ wrapper, definition }) => buildPythonFunctionAndBranchUnits(
            filePath,
            content,
            language,
            role,
            wrapper,
            definition,
            parseStatus,
            className
        ));
}

function buildPythonFunctionAndBranchUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    functionNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    className?: string
): LogicalUnit[] {
    const functionUnit = buildPythonFunctionUnit(
        filePath,
        content,
        language,
        role,
        wrapperNode,
        functionNode,
        parseStatus,
        className
    );
    return [
        functionUnit,
        ...extractPythonBranchUnits(filePath, content, language, role, functionNode, functionUnit, parseStatus)
    ];
}

function buildPythonFunctionUnit(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    functionNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    className?: string
): LogicalUnit {
    const symbol = extractNodeName(functionNode, content) ?? 'anonymous';
    const sourceNode = wrapperNode.type === 'decorated_definition' ? wrapperNode : functionNode;
    return buildUnit({
        type: className ? 'method' : 'function',
        symbol,
        filePath,
        language,
        content: content.slice(sourceNode.startIndex, sourceNode.endIndex),
        startLine: sourceNode.startPosition.row + 1,
        endLine: sourceNode.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        parentSymbol: className,
        metadata: {
            confidence: 'high',
            isAsync: isAsyncPythonFunction(functionNode, content),
            className,
            decorators: extractDecorators(wrapperNode, content),
            parameters: extractPythonParameters(functionNode, content)
        }
    });
}

function buildPythonClassUnit(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    classNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit {
    const symbol = extractNodeName(classNode, content) ?? 'AnonymousClass';
    const sourceNode = wrapperNode.type === 'decorated_definition' ? wrapperNode : classNode;
    return buildUnit({
        type: 'class',
        symbol,
        filePath,
        language,
        content: content.slice(sourceNode.startIndex, sourceNode.endIndex),
        startLine: sourceNode.startPosition.row + 1,
        endLine: sourceNode.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        metadata: {
            confidence: 'high',
            decorators: extractDecorators(wrapperNode, content)
        }
    });
}

function extractPythonBranchUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    functionNode: SyntaxNode,
    parentUnit: LogicalUnit,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    if (parentUnit.endLine - parentUnit.startLine <= 150) {
        return [];
    }

    const branches: LogicalUnit[] = [];
    for (const child of functionBodyChildren(functionNode)) {
        for (const branchNode of topLevelBranchNodes(child)) {
            const branchKind = pythonBranchKind(branchNode);
            if (!branchKind) {
                continue;
            }
            branches.push(buildUnit({
                type: 'branch',
                symbol: `${parentUnit.symbol ?? 'anonymous'}.${branchKind}`,
                filePath,
                language,
                content: content.slice(branchNode.startIndex, branchNode.endIndex),
                startLine: branchNode.startPosition.row + 1,
                endLine: branchNode.endPosition.row + 1,
                role,
                parseStatus,
                extractionMethod: parentUnit.extractionMethod,
                parentUnitId: parentUnit.id,
                parentSymbol: parentUnit.symbol,
                metadata: {
                    confidence: parentUnit.metadata.confidence,
                    branchKind,
                    className: parentUnit.metadata.className
                }
            }));
        }
    }
    return branches;
}

function extractTsJsTreeUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    rootNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const units: LogicalUnit[] = [];
    const topLevelNodes = namedChildren(rootNode);

    const importBlock = extractTsJsImportBlock(filePath, content, language, role, topLevelNodes, parseStatus);
    if (importBlock) {
        units.push(importBlock);
    }

    units.push(...extractTsJsConstantBlocks(filePath, content, language, role, topLevelNodes, parseStatus));

    for (const node of topLevelNodes) {
        const exported = node.type === 'export_statement';
        const declaration = exported ? firstNamedChild(node) : node;
        if (!declaration) {
            continue;
        }

        if (declaration.type === 'function_declaration') {
            units.push(...buildTsJsFunctionAndBranchUnits(filePath, content, language, role, node, declaration, parseStatus, { isExported: exported }));
            continue;
        }

        if (declaration.type === 'class_declaration') {
            units.push(buildTsJsClassUnit(filePath, content, language, role, node, declaration, parseStatus, exported));
            units.push(...extractTsJsClassMethodUnits(filePath, content, language, role, declaration, parseStatus));
            continue;
        }

        if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
            const declarationExported = exported || isExportedNode(node, content);
            units.push(...extractTsJsArrowFunctionUnits(filePath, content, language, role, declaration, parseStatus, declarationExported));
            units.push(...extractTsJsObjectMethodUnits(filePath, content, language, role, declaration, parseStatus, declarationExported));
        }
    }

    units.push(...extractTsJsPromptUnits(filePath, content, language, role, topLevelNodes, parseStatus));
    units.push(...extractTsJsConfigUnits(filePath, content, language, role, topLevelNodes, parseStatus));

    return units;
}

function extractTsJsImportBlock(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit | undefined {
    const imports: SyntaxNode[] = [];
    for (const node of topLevelNodes) {
        if (node.type === 'comment') {
            continue;
        }
        if (node.type === 'import_statement') {
            imports.push(node);
            continue;
        }
        break;
    }
    if (imports.length === 0) {
        return undefined;
    }
    const first = imports[0];
    const last = imports[imports.length - 1];
    const text = content.slice(first.startIndex, last.endIndex);
    return buildUnit({
        type: 'import_block',
        filePath,
        language,
        content: text,
        startLine: first.startPosition.row + 1,
        endLine: last.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        metadata: {
            confidence: 'high',
            readsSymbols: extractTsJsIdentifiers(text).filter(token => !['import', 'from', 'as', 'type'].includes(token))
        }
    });
}

function extractTsJsConstantBlocks(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const declarations = topLevelNodes
        .map(node => node.type === 'export_statement' ? firstNamedChild(node) : node)
        .filter((node): node is SyntaxNode => Boolean(node && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')));
    const groups: SyntaxNode[][] = [];
    let current: SyntaxNode[] = [];

    for (const declaration of declarations) {
        const previous = current[current.length - 1];
        if (previous && declaration.startPosition.row + 1 - (previous.endPosition.row + 1) - 1 > 1) {
            groups.push(current);
            current = [];
        }
        current.push(declaration);
    }
    if (current.length > 0) {
        groups.push(current);
    }

    return groups.map(group => {
        const first = group[0];
        const last = group[group.length - 1];
        const text = content.slice(first.startIndex, last.endIndex);
        const symbols = uniqueStrings(group.flatMap(node => extractTsJsAssignedNames(node, content)));
        return buildUnit({
            type: 'constant_block',
            symbol: symbols[0],
            filePath,
            language,
            content: text,
            startLine: first.startPosition.row + 1,
            endLine: last.endPosition.row + 1,
            role,
            parseStatus,
            extractionMethod: 'tree_sitter',
            metadata: {
                confidence: 'high',
                readsSymbols: symbols,
                writesSymbols: symbols,
                valuePreview: previewValue(text)
            }
        });
    });
}

function extractTsJsPromptUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    return topLevelNodes
        .flatMap(node => tsJsVariableDeclarators(node.type === 'export_statement' ? firstNamedChild(node) ?? node : node))
        .filter(node => extractTsJsAssignedNames(node, content).some(name => PROMPT_NAME_PATTERN.test(name)))
        .filter(node => tsJsInitializerHasString(node, content))
        .map(node => {
            const names = extractTsJsAssignedNames(node, content);
            const text = content.slice(node.startIndex, node.endIndex);
            return buildUnit({
                type: 'prompt_template',
                symbol: names[0],
                filePath,
                language,
                content: text,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                role,
                parseStatus,
                extractionMethod: 'tree_sitter',
                metadata: {
                    confidence: 'high',
                    readsSymbols: names,
                    writesSymbols: names,
                    valuePreview: previewValue(text)
                }
            });
        });
}

function extractTsJsConfigUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    topLevelNodes: SyntaxNode[],
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    return topLevelNodes
        .flatMap(node => tsJsVariableDeclarators(node.type === 'export_statement' ? firstNamedChild(node) ?? node : node))
        .filter(node => JS_CONFIG_PATTERN.test(content.slice(node.startIndex, node.endIndex)))
        .map(node => {
            const names = extractTsJsAssignedNames(node, content);
            const text = content.slice(node.startIndex, node.endIndex);
            return buildUnit({
                type: 'config_block',
                symbol: names[0],
                filePath,
                language,
                content: text,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                role,
                parseStatus,
                extractionMethod: 'tree_sitter',
                metadata: {
                    confidence: 'high',
                    readsSymbols: names,
                    writesSymbols: names,
                    valuePreview: previewValue(text)
                }
            });
        });
}

function extractTsJsClassMethodUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    classNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    const className = extractNodeName(classNode, content);
    return tsJsClassBodyChildren(classNode)
        .filter(child => child.type === 'method_definition')
        .flatMap(methodNode => buildTsJsFunctionAndBranchUnits(
            filePath,
            content,
            language,
            role,
            methodNode,
            methodNode,
            parseStatus,
            { className, forceMethod: true }
        ));
}

function extractTsJsArrowFunctionUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    declarationNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    isExported: boolean
): LogicalUnit[] {
    return tsJsVariableDeclarators(declarationNode)
        .map(declarator => ({ declarator, arrow: namedChildren(declarator).find(child => child.type === 'arrow_function') }))
        .filter((item): item is {declarator: SyntaxNode; arrow: SyntaxNode} => Boolean(item.arrow))
        .flatMap(({ declarator, arrow }) => buildTsJsFunctionAndBranchUnits(
            filePath,
            content,
            language,
            role,
            declarationNode,
            arrow,
            parseStatus,
            { symbol: extractTsJsAssignedNames(declarator, content)[0], isExported }
        ));
}

function extractTsJsObjectMethodUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    declarationNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    isExported: boolean
): LogicalUnit[] {
    return tsJsVariableDeclarators(declarationNode).flatMap(declarator => {
        const objectNode = namedChildren(declarator).find(child => child.type === 'object');
        if (!objectNode) {
            return [];
        }
        const objectName = extractTsJsAssignedNames(declarator, content)[0];
        return namedChildren(objectNode)
            .filter(child => child.type === 'method_definition')
            .flatMap(methodNode => buildTsJsFunctionAndBranchUnits(
                filePath,
                content,
                language,
                role,
                methodNode,
                methodNode,
                parseStatus,
                { className: objectName, forceMethod: true, isExported }
            ));
    });
}

function buildTsJsFunctionAndBranchUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    functionNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    options: { symbol?: string; className?: string; forceMethod?: boolean; isExported?: boolean } = {}
): LogicalUnit[] {
    const functionUnit = buildTsJsFunctionUnit(filePath, content, language, role, wrapperNode, functionNode, parseStatus, options);
    return [
        functionUnit,
        ...extractTsJsBranchUnits(filePath, content, language, role, functionNode, functionUnit, parseStatus)
    ];
}

function buildTsJsFunctionUnit(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    functionNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    options: { symbol?: string; className?: string; forceMethod?: boolean; isExported?: boolean }
): LogicalUnit {
    const symbol = options.symbol ?? extractNodeName(functionNode, content) ?? 'anonymous';
    const sourceNode = functionNode.type === 'arrow_function' ? wrapperNode : functionNode;
    return buildUnit({
        type: options.forceMethod || functionNode.type === 'method_definition' ? 'method' : 'function',
        symbol,
        filePath,
        language,
        content: content.slice(sourceNode.startIndex, sourceNode.endIndex),
        startLine: sourceNode.startPosition.row + 1,
        endLine: sourceNode.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        parentSymbol: options.className,
        metadata: {
            confidence: 'high',
            isAsync: isAsyncTsJsFunction(functionNode, content),
            isExported: options.isExported ?? isExportedNode(wrapperNode, content),
            className: options.className,
            parameters: extractTsJsParameters(functionNode, content),
            returnType: extractTsJsReturnType(functionNode, content)
        }
    });
}

function buildTsJsClassUnit(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    wrapperNode: SyntaxNode,
    classNode: SyntaxNode,
    parseStatus: LogicalUnitParseStatus,
    isExported: boolean
): LogicalUnit {
    const symbol = extractNodeName(classNode, content) ?? 'AnonymousClass';
    const sourceNode = wrapperNode.type === 'export_statement' ? wrapperNode : classNode;
    return buildUnit({
        type: 'class',
        symbol,
        filePath,
        language,
        content: content.slice(sourceNode.startIndex, sourceNode.endIndex),
        startLine: sourceNode.startPosition.row + 1,
        endLine: sourceNode.endPosition.row + 1,
        role,
        parseStatus,
        extractionMethod: 'tree_sitter',
        metadata: {
            confidence: 'high',
            isExported
        }
    });
}

function extractTsJsBranchUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole,
    functionNode: SyntaxNode,
    parentUnit: LogicalUnit,
    parseStatus: LogicalUnitParseStatus
): LogicalUnit[] {
    if (parentUnit.endLine - parentUnit.startLine <= 150) {
        return [];
    }

    const branches: LogicalUnit[] = [];
    for (const child of tsJsFunctionBodyChildren(functionNode)) {
        for (const branchNode of tsJsTopLevelBranchNodes(child)) {
            const branchKind = tsJsBranchKind(branchNode);
            if (!branchKind) {
                continue;
            }
            branches.push(buildUnit({
                type: 'branch',
                symbol: `${parentUnit.symbol ?? 'anonymous'}.${branchKind}`,
                filePath,
                language,
                content: content.slice(branchNode.startIndex, branchNode.endIndex),
                startLine: branchNode.startPosition.row + 1,
                endLine: branchNode.endPosition.row + 1,
                role,
                parseStatus,
                extractionMethod: parentUnit.extractionMethod,
                parentUnitId: parentUnit.id,
                parentSymbol: parentUnit.symbol,
                metadata: {
                    confidence: parentUnit.metadata.confidence,
                    branchKind,
                    className: parentUnit.metadata.className
                }
            }));
        }
    }
    return branches;
}

function extractTsJsWithRegex(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const units: LogicalUnit[] = [];
    const patterns: Array<{pattern: RegExp; type: 'function' | 'class'; async?: boolean; arrow?: boolean}> = [
        { pattern: /\bexport\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, type: 'function' },
        { pattern: /\b(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, type: 'function' },
        { pattern: /\bexport\s+class\s+([A-Za-z_$][\w$]*)\b/g, type: 'class' },
        { pattern: /\bclass\s+([A-Za-z_$][\w$]*)\b/g, type: 'class' },
        { pattern: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, type: 'function', arrow: true }
    ];

    for (const { pattern, type, arrow } of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const symbol = type === 'class'
                ? match[1]
                : arrow
                    ? match[1]
                    : match[2];
            const openBrace = content.indexOf('{', match.index);
            if (!symbol || openBrace === -1) {
                continue;
            }
            const endIndex = findMatchingBrace(content, openBrace);
            if (endIndex === -1) {
                continue;
            }
            const sourceEnd = includeTrailingSemicolon(content, endIndex);
            const prefix = content.slice(match.index, Math.min(match.index + 96, content.length));
            units.push(buildUnit({
                type,
                symbol,
                filePath,
                language,
                content: content.slice(match.index, sourceEnd + 1),
                startLine: lineNumberAt(content, match.index),
                endLine: lineNumberAt(content, sourceEnd),
                role,
                parseStatus: 'regex_fallback',
                extractionMethod: 'regex',
                metadata: {
                    confidence: 'medium',
                    isAsync: /\basync\b/.test(prefix),
                    isExported: /\bexport\b/.test(prefix)
                }
            }));
        }
    }

    if (units.length === 0) {
        return wholeFileFallback(filePath, content, language, role);
    }
    return sortAndDedupeUnits(units);
}

function extractUnsupportedSourceWithRegex(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const units = language === 'ruby'
        ? extractRubyWithRegex(filePath, content, language, role)
        : extractBraceLanguageWithRegex(filePath, content, language, role);
    return units.length > 0 ? sortAndDedupeUnits(units) : wholeFileFallback(filePath, content, language, role);
}

function extractRubyWithRegex(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const lines = content.split(/\r?\n/);
    const units: LogicalUnit[] = [];
    const pattern = /^(\s*)(def|class)\s+([A-Za-z_][A-Za-z0-9_:!?=]*)/;

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(pattern);
        if (!match || indentationWidth(match[1]) !== 0) {
            continue;
        }
        const endIndex = findRubyBlockEnd(lines, index);
        const type = match[2] === 'class' ? 'class' : 'function';
        units.push(buildUnit({
            type,
            symbol: match[3].split('::').pop(),
            filePath,
            language,
            content: lines.slice(index, endIndex + 1).join('\n'),
            startLine: index + 1,
            endLine: endIndex + 1,
            role,
            parseStatus: 'regex_fallback',
            extractionMethod: 'regex',
            metadata: {
                confidence: 'medium'
            }
        }));
    }
    return units;
}

function extractBraceLanguageWithRegex(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const units: LogicalUnit[] = [];
    const patterns: Array<{pattern: RegExp; type: 'function' | 'class'}> = [
        { pattern: /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, type: 'function' },
        { pattern: /\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)\s*\{/g, type: 'class' },
        { pattern: /\b(?:function|fn)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, type: 'function' },
        { pattern: /\b(?:class|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, type: 'class' }
    ];

    for (const { pattern, type } of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const openBrace = content.indexOf('{', match.index);
            if (!match[1] || openBrace === -1) {
                continue;
            }
            const endIndex = findMatchingBrace(content, openBrace);
            if (endIndex === -1) {
                continue;
            }
            units.push(buildUnit({
                type,
                symbol: match[1],
                filePath,
                language,
                content: content.slice(match.index, endIndex + 1),
                startLine: lineNumberAt(content, match.index),
                endLine: lineNumberAt(content, endIndex),
                role,
                parseStatus: 'regex_fallback',
                extractionMethod: 'regex',
                metadata: {
                    confidence: 'medium'
                }
            }));
        }
    }
    return units;
}

function extractUsefulNonSourceUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    if (role === 'config') {
        const units = extractConfigLikeTextUnits(filePath, content, language, role);
        return sortAndDedupeUnits(units);
    }
    if (role === 'docs') {
        const promptUnits = extractPromptLikeTextUnits(filePath, content, language, role);
        return sortAndDedupeUnits(promptUnits);
    }
    return [];
}

function extractConfigLikeTextUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const lines = content.split(/\r?\n/);
    const units: LogicalUnit[] = [];
    let start: number | undefined;
    let collected: string[] = [];

    lines.forEach((line, index) => {
        if (/\b(?:process\.env|os\.getenv|os\.environ|dotenv|[A-Z][A-Z0-9_]*\s*=)/.test(line)) {
            start ??= index;
            collected.push(line);
            return;
        }
        if (start !== undefined && collected.length > 0) {
            const text = collected.join('\n');
            units.push(buildUnit({
                type: 'config_block',
                filePath,
                language,
                content: text,
                startLine: start + 1,
                endLine: index,
                role,
                parseStatus: 'regex_fallback',
                extractionMethod: 'regex',
                metadata: {
                    confidence: 'medium',
                    readsSymbols: extractTsJsIdentifiers(text),
                    valuePreview: previewValue(text)
                }
            }));
            start = undefined;
            collected = [];
        }
    });

    if (start !== undefined && collected.length > 0) {
        const text = collected.join('\n');
        units.push(buildUnit({
            type: 'config_block',
            filePath,
            language,
            content: text,
            startLine: start + 1,
            endLine: lines.length,
            role,
            parseStatus: 'regex_fallback',
            extractionMethod: 'regex',
            metadata: {
                confidence: 'medium',
                readsSymbols: extractTsJsIdentifiers(text),
                valuePreview: previewValue(text)
            }
        }));
    }
    return units;
}

function extractPromptLikeTextUnits(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const units: LogicalUnit[] = [];
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
        if (!PROMPT_NAME_PATTERN.test(line)) {
            return;
        }
        units.push(buildUnit({
            type: 'prompt_template',
            filePath,
            language,
            content: line,
            startLine: index + 1,
            endLine: index + 1,
            role,
            parseStatus: 'regex_fallback',
            extractionMethod: 'regex',
            metadata: {
                confidence: 'medium',
                readsSymbols: extractTsJsIdentifiers(line),
                valuePreview: previewValue(line)
            }
        }));
    });
    return units;
}

function tsJsVariableDeclarators(node: SyntaxNode): SyntaxNode[] {
    if (node.type === 'variable_declarator') {
        return [node];
    }
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
        return [];
    }
    return namedChildren(node).filter(child => child.type === 'variable_declarator');
}

function extractTsJsAssignedNames(node: SyntaxNode, content: string): string[] {
    const declarators = node.type === 'variable_declarator' ? [node] : tsJsVariableDeclarators(node);
    return uniqueStrings(declarators.flatMap(declarator => {
        const nameNode = declarator.childForFieldName('name') ?? firstNamedChild(declarator);
        if (!nameNode) {
            return [];
        }
        return collectIdentifiers(nameNode, content);
    }));
}

function tsJsInitializerHasString(node: SyntaxNode, content: string): boolean {
    const valueNode = node.childForFieldName('value') ?? namedChildren(node)[1];
    if (valueNode && containsNodeType(valueNode, new Set(['string', 'template_string']))) {
        return true;
    }
    return /=\s*(?:`|'|")/.test(content.slice(node.startIndex, node.endIndex));
}

function tsJsClassBodyChildren(classNode: SyntaxNode): SyntaxNode[] {
    const body = classNode.childForFieldName('body') ?? namedChildren(classNode).find(child => child.type === 'class_body');
    return body ? namedChildren(body) : [];
}

function tsJsFunctionBodyChildren(functionNode: SyntaxNode): SyntaxNode[] {
    const body = functionNode.childForFieldName('body') ?? namedChildren(functionNode).find(child => child.type === 'statement_block');
    return body ? namedChildren(body) : [];
}

function tsJsTopLevelBranchNodes(node: SyntaxNode): SyntaxNode[] {
    const branchKind = tsJsBranchKind(node);
    if (!branchKind) {
        return [];
    }

    const nodes = [node];
    if (node.type === 'if_statement' || node.type === 'try_statement') {
        nodes.push(...namedChildren(node).filter(child =>
            child.type === 'else_clause' ||
            child.type === 'catch_clause' ||
            child.type === 'finally_clause'
        ));
    }
    return nodes;
}

function tsJsBranchKind(node: SyntaxNode): string | undefined {
    switch (node.type) {
        case 'if_statement':
            return 'if';
        case 'else_clause': {
            const child = firstNamedChild(node);
            return child?.type === 'if_statement' ? 'else if' : 'else';
        }
        case 'for_statement':
        case 'for_in_statement':
        case 'for_of_statement':
            return 'for';
        case 'while_statement':
        case 'do_statement':
            return 'while';
        case 'try_statement':
            return 'try';
        case 'catch_clause':
            return 'catch';
        case 'finally_clause':
            return 'finally';
        case 'switch_statement':
            return 'switch';
        default:
            return undefined;
    }
}

function isAsyncTsJsFunction(node: SyntaxNode, content: string): boolean {
    return /^\s*async\b/.test(content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 64)));
}

function isExportedNode(node: SyntaxNode, content: string): boolean {
    if (node.type === 'export_statement') {
        return true;
    }
    return /\bexport\b/.test(content.slice(Math.max(0, node.startIndex - 32), Math.min(node.endIndex, node.startIndex + 64)));
}

function extractTsJsParameters(node: SyntaxNode, content: string): string[] {
    const params = node.childForFieldName('parameters') ?? namedChildren(node).find(child => child.type === 'formal_parameters');
    if (!params) {
        return [];
    }
    return uniqueStrings(namedChildren(params).flatMap(child => {
        if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
            const patternNode = child.childForFieldName('pattern') ?? firstNamedChild(child);
            return patternNode ? collectIdentifiers(patternNode, content) : [];
        }
        if (child.type === 'identifier') {
            return [content.slice(child.startIndex, child.endIndex)];
        }
        return [];
    }));
}

function extractTsJsReturnType(node: SyntaxNode, content: string): string | undefined {
    const typeNode = namedChildren(node).find(child => child.type === 'type_annotation');
    if (!typeNode) {
        return undefined;
    }
    return content.slice(typeNode.startIndex, typeNode.endIndex).replace(/^:\s*/, '').trim();
}

function extractPythonWithRegex(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    const lines = content.split(/\r?\n/);
    const units: LogicalUnit[] = [];
    const definitionPattern = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(definitionPattern);
        if (!match) {
            continue;
        }
        const indent = indentationWidth(match[1]);
        if (indent !== 0) {
            continue;
        }
        const kind = match[2];
        const symbol = match[3];
        const endIndex = findPythonBlockEnd(lines, index, indent);
        units.push(buildUnit({
            type: kind === 'class' ? 'class' : 'function',
            symbol,
            filePath,
            language,
            content: lines.slice(index, endIndex + 1).join('\n'),
            startLine: index + 1,
            endLine: endIndex + 1,
            role,
            parseStatus: 'regex_fallback',
            extractionMethod: 'regex',
            metadata: {
                confidence: 'medium',
                isAsync: kind === 'async def'
            }
        }));
    }

    if (units.length === 0) {
        return wholeFileFallback(filePath, content, language, role);
    }
    return sortAndDedupeUnits(units);
}

function wholeFileFallback(
    filePath: string,
    content: string,
    language: string,
    role: LogicalUnitRole
): LogicalUnit[] {
    if (content.length === 0 || looksBinary(content)) {
        return [];
    }
    const lineCount = content.split(/\r?\n/).length;
    return [buildUnit({
        type: 'whole_file_fallback',
        filePath,
        language,
        content,
        startLine: 1,
        endLine: lineCount,
        role,
        parseStatus: 'whole_file_fallback',
        extractionMethod: 'fallback',
        metadata: {
            confidence: 'low'
        }
    })];
}

function isNonSourceRole(role: LogicalUnitRole): boolean {
    return role === 'docs' || role === 'config' || role === 'script' || role === 'unknown';
}

function buildUnit(options: UnitBuildOptions): LogicalUnit {
    const metadata: LogicalUnitMetadata = {
        confidence: options.metadata?.confidence ?? defaultConfidence(options.extractionMethod),
        ...options.metadata
    };

    const persistentTypes = new Set([
        'file', 'class', 'interface', 'function', 'method', 
        'constant', 'type_alias', 'constant_block', 'whole_file_fallback'
    ]);
    const requires_identity = persistentTypes.has(options.type);

    return {
        id: `${options.filePath}::${options.symbol ?? 'block'}::${options.type}::${options.startLine}`,
        requires_identity,
        type: options.type,
        symbol: options.symbol,
        filePath: options.filePath,
        language: options.language,
        startLine: options.startLine,
        endLine: options.endLine,
        content: options.content,
        parentUnitId: options.parentUnitId,
        parentSymbol: options.parentSymbol,
        role: options.role,
        parseStatus: options.parseStatus,
        extractionMethod: options.extractionMethod,
        metadata
    };
}

function isTopLevelAssignment(node: SyntaxNode): boolean {
    return Boolean(getAssignmentNode(node));
}

function isPythonFunctionNode(node: SyntaxNode): boolean {
    return node.type === 'function_definition' || node.type === 'async_function_definition';
}

function topLevelBranchNodes(node: SyntaxNode): SyntaxNode[] {
    const branchKind = pythonBranchKind(node);
    if (!branchKind) {
        return [];
    }

    const nodes = [node];
    if (node.type === 'if_statement' || node.type === 'try_statement' || node.type === 'match_statement') {
        nodes.push(...namedChildren(node).filter(child =>
            child.type === 'elif_clause' ||
            child.type === 'else_clause' ||
            child.type === 'except_clause' ||
            child.type === 'finally_clause' ||
            child.type === 'case_clause'
        ));
    }
    return nodes;
}

function pythonBranchKind(node: SyntaxNode): string | undefined {
    switch (node.type) {
        case 'if_statement':
            return 'if';
        case 'elif_clause':
            return 'elif';
        case 'else_clause':
            return 'else';
        case 'for_statement':
            return 'for';
        case 'while_statement':
            return 'while';
        case 'try_statement':
            return 'try';
        case 'except_clause':
            return 'except';
        case 'finally_clause':
            return 'finally';
        case 'with_statement':
            return 'with';
        case 'match_statement':
            return 'match';
        case 'case_clause':
            return 'case';
        default:
            return undefined;
    }
}

function isAsyncPythonFunction(node: SyntaxNode, content: string): boolean {
    return node.type === 'async_function_definition' ||
        /^\s*async\s+def\b/.test(content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 64)));
}

function unwrapDecoratedDefinition(node: SyntaxNode): SyntaxNode | undefined {
    if (node.type !== 'decorated_definition') {
        return node;
    }
    return namedChildren(node).find(child => child.type !== 'decorator');
}

function extractNodeName(node: SyntaxNode, content: string): string | undefined {
    const nameNode = node.childForFieldName('name') ??
        namedChildren(node).find(child => child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier');
    return nameNode ? content.slice(nameNode.startIndex, nameNode.endIndex) : undefined;
}

function extractAssignedNames(node: SyntaxNode, content: string): string[] {
    const assignmentNode = getAssignmentNode(node) ?? node;
    const leftNode = assignmentNode.childForFieldName('left') ??
        assignmentNode.childForFieldName('name') ??
        namedChildren(assignmentNode)[0];
    if (!leftNode) {
        return [];
    }
    const names = collectIdentifiers(leftNode, content);
    return uniqueStrings(names.filter(name => PYTHON_IDENTIFIER_PATTERN.test(name)));
}

function assignmentHasStringValue(node: SyntaxNode, content: string): boolean {
    const assignmentNode = getAssignmentNode(node) ?? node;
    const assignmentChildren = namedChildren(assignmentNode);
    const rightNode = assignmentNode.childForFieldName('right') ?? assignmentChildren[assignmentChildren.length - 1];
    if (rightNode && containsNodeType(rightNode, new Set(['string', 'concatenated_string']))) {
        return true;
    }
    const text = content.slice(node.startIndex, node.endIndex);
    return /=\s*(?:[furbFURB]*("""|'''|"|'))/.test(text);
}

function getAssignmentNode(node: SyntaxNode): SyntaxNode | undefined {
    if (node.type === 'assignment' || node.type === 'augmented_assignment' || node.type === 'annotated_assignment') {
        return node;
    }
    if (node.type !== 'expression_statement') {
        return undefined;
    }
    return namedChildren(node).find(child =>
        child.type === 'assignment' ||
        child.type === 'augmented_assignment' ||
        child.type === 'annotated_assignment'
    );
}

function classBodyChildren(classNode: SyntaxNode): SyntaxNode[] {
    const body = classNode.childForFieldName('body') ?? namedChildren(classNode).find(child => child.type === 'block');
    return body ? namedChildren(body) : [];
}

function functionBodyChildren(functionNode: SyntaxNode): SyntaxNode[] {
    const body = functionNode.childForFieldName('body') ?? namedChildren(functionNode).find(child => child.type === 'block');
    return body ? namedChildren(body) : [];
}

function isBaseSettingsClass(classNode: SyntaxNode, content: string): boolean {
    const headerEnd = content.indexOf(':', classNode.startIndex);
    const header = content.slice(classNode.startIndex, headerEnd === -1 ? classNode.endIndex : headerEnd);
    return /\bBaseSettings\b/.test(header);
}

function extractPythonParameters(functionNode: SyntaxNode, content: string): string[] {
    const parametersNode = functionNode.childForFieldName('parameters') ??
        namedChildren(functionNode).find(child => child.type === 'parameters');
    if (!parametersNode) {
        return [];
    }
    return uniqueStrings(collectIdentifiers(parametersNode, content)
        .filter(name => !['self', 'cls'].includes(name)));
}

function extractDecorators(wrapperNode: SyntaxNode, content: string): string[] {
    if (wrapperNode.type !== 'decorated_definition') {
        return [];
    }
    return namedChildren(wrapperNode)
        .filter(child => child.type === 'decorator')
        .map(child => content.slice(child.startIndex, child.endIndex).replace(/^@/, '').trim())
        .filter(Boolean);
}

function extractImportSymbols(text: string): string[] {
    return uniqueStrings(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        .filter(token => !['import', 'from', 'as'].includes(token));
}

function collectIdentifiers(node: SyntaxNode, content: string): string[] {
    const names: string[] = [];
    walk(node, child => {
        if (child.type === 'identifier') {
            names.push(content.slice(child.startIndex, child.endIndex));
        }
    });
    return names;
}

function containsNodeType(node: SyntaxNode, types: Set<string>): boolean {
    let found = false;
    walk(node, child => {
        if (types.has(child.type)) {
            found = true;
        }
    });
    return found;
}

function walk(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
    visitor(node);
    for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index);
        if (child) {
            walk(child, visitor);
        }
    }
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
    const children: SyntaxNode[] = [];
    for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index);
        if (child) {
            children.push(child);
        }
    }
    return children;
}

function firstNamedChild(node: SyntaxNode): SyntaxNode | undefined {
    return namedChildren(node)[0];
}

function extractTsJsIdentifiers(text: string): string[] {
    return uniqueStrings(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

function findPythonBlockEnd(lines: string[], startIndex: number, baseIndent: number): number {
    let endIndex = startIndex;
    for (let index = startIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) {
            endIndex = index;
            continue;
        }
        const indent = indentationWidth(line.match(/^[ \t]*/)?.[0] ?? '');
        if (indent <= baseIndent) {
            break;
        }
        endIndex = index;
    }
    while (endIndex > startIndex && !lines[endIndex].trim()) {
        endIndex--;
    }
    return endIndex;
}

function findRubyBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let endIndex = startIndex;
    for (let index = startIndex; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (/^(class|module|def|if|unless|case|begin|for|while|until)\b/.test(trimmed) || /\bdo\b/.test(trimmed)) {
            depth++;
        }
        if (trimmed === 'end') {
            depth--;
            endIndex = index;
            if (depth <= 0) {
                return index;
            }
            continue;
        }
        endIndex = index;
    }
    return endIndex;
}

function indentationWidth(indent: string): number {
    return indent.replace(/\t/g, '    ').length;
}

function findMatchingBrace(content: string, openBraceIndex: number): number {
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let index = openBraceIndex; index < content.length; index++) {
        const char = content[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === '`') {
            quote = char;
            continue;
        }
        if (char === '{') {
            depth++;
            continue;
        }
        if (char === '}') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function includeTrailingSemicolon(content: string, index: number): number {
    let cursor = index + 1;
    while (cursor < content.length && /\s/.test(content[cursor])) {
        cursor++;
    }
    return content[cursor] === ';' ? cursor : index;
}

function lineNumberAt(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
}

function sortAndDedupeUnits(units: LogicalUnit[]): LogicalUnit[] {
    const seen = new Set<string>();
    return [...units]
        .sort((a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.startLine - b.startLine ||
            a.endLine - b.endLine ||
            a.type.localeCompare(b.type) ||
            a.id.localeCompare(b.id)
        )
        .filter(unit => {
            if (seen.has(unit.id)) {
                return false;
            }
            seen.add(unit.id);
            return true;
        });
}

function defaultConfidence(method: LogicalUnitExtractionMethod): 'high' | 'medium' | 'low' {
    if (method === 'tree_sitter') {
        return 'high';
    }
    if (method === 'regex') {
        return 'medium';
    }
    return 'low';
}

function previewValue(text: string): string {
    return text.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function isStringExpression(text: string): boolean {
    const trimmed = text.trim();
    return /^(?:[furbFURB]*("""|'''|"|'))/.test(trimmed);
}

function looksBinary(content: string): boolean {
    return content.includes('\u0000');
}

function normalizeRepoPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').replace(/^\.\//, '');
}

function isInsideDirectory(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}
