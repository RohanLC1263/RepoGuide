import * as path from 'path';
import { FileStructure, FunctionNode, FunctionSignature } from '../types';

const ENTRY_FILE_NAME_PATTERN = /^(index|main|app|server|cli|__main__)$/i;
const ENTRY_FUNCTION_NAME_PATTERN = /^(main|execute|run|start|handle|process|init)$/i;
const BODY_PREVIEW_LINE_LIMIT = 20;

export function extractFunctionNodes(
    fileStructures: FileStructure[]
): Record<string, FunctionNode> {
    const nodes: Record<string, FunctionNode> = {};

    for (const file of fileStructures) {
        const normalizedFilePath = path.normalize(file.filePath);

        for (const fn of file.functions) {
            const node = buildFunctionNode(normalizedFilePath, fn);
            nodes[node.id] = node;
        }

        for (const cls of file.classes) {
            // Add the class itself to allow constructor call resolution (e.g., BaseAgent())
            const classNode: FunctionNode = {
                id: `${normalizedFilePath}::${cls.name}`,
                filePath: normalizedFilePath,
                functionName: cls.name,
                className: undefined,
                startLine: cls.startLine,
                endLine: cls.endLine,
                isExported: true,
                isEntryPoint: isEntryPoint(normalizedFilePath, cls.name),
                docstring: cls.docstring ?? undefined,
                bodyPreview: undefined,
                outboundCalls: [],
                inboundCalls: [],
                callCount: 0,
                importance: 0
            };
            nodes[classNode.id] = classNode;

            for (const method of cls.methods) {
                const node = buildFunctionNode(normalizedFilePath, method, cls.name);
                nodes[node.id] = node;
            }
        }
    }

    return nodes;
}

function buildFunctionNode(
    normalizedFilePath: string,
    signature: FunctionSignature,
    className?: string
): FunctionNode {
    const functionName = signature.name;
    const id = className
        ? `${normalizedFilePath}::${className}.${functionName}`
        : `${normalizedFilePath}::${functionName}`;

    return {
        id,
        filePath: normalizedFilePath,
        functionName,
        className,
        startLine: signature.startLine,
        endLine: signature.endLine,
        isExported: signature.isExported ?? false,
        isEntryPoint: isEntryPoint(normalizedFilePath, functionName),
        docstring: signature.docstring ?? undefined,
        bodyPreview: truncatePreview(signature.bodyPreview),
        outboundCalls: [],
        inboundCalls: [],
        callCount: 0,
        importance: 0
    };
}

function isEntryPoint(filePath: string, functionName: string): boolean {
    return ENTRY_FILE_NAME_PATTERN.test(path.parse(filePath).name)
        || ENTRY_FUNCTION_NAME_PATTERN.test(functionName);
}

function truncatePreview(bodyPreview?: string): string | undefined {
    if (!bodyPreview) {
        return undefined;
    }

    return bodyPreview.split(/\r?\n/).slice(0, BODY_PREVIEW_LINE_LIMIT).join('\n');
}
