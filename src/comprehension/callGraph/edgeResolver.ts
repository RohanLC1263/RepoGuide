import * as path from 'path';
import {
    FileStructure,
    FunctionCall,
    FunctionEdge,
    FunctionNode,
    FunctionSignature,
    ImportReference
} from '../types';

export function resolveEdges(
    nodes: Record<string, FunctionNode>,
    fileStructures: FileStructure[]
): { edges: FunctionEdge[]; unresolvedCalls: FunctionCall[] } {
    const allNodes = Object.values(nodes);
    const symbolLookup = buildSymbolLookup(allNodes);
    const fileNodeLookup = buildFileNodeLookup(allNodes);
    const edges: FunctionEdge[] = [];
    const unresolvedCalls: FunctionCall[] = [];

    for (const file of fileStructures) {
        const normalizedFilePath = path.normalize(file.filePath);

        for (const fn of file.functions) {
            const callerId = buildNodeId(normalizedFilePath, fn.name);
            if (!nodes[callerId]) {
                continue;
            }
            const result = resolveEdgesForSignature(
                callerId,
                fn.calls,
                file,
                fileNodeLookup,
                symbolLookup
            );
            unresolvedCalls.push(...result.unresolvedCalls);
            edges.push(...result.edges);
        }

        for (const cls of file.classes) {
            for (const method of cls.methods) {
                const callerId = buildNodeId(normalizedFilePath, method.name, cls.name);
                if (!nodes[callerId]) {
                    continue;
                }
                const result = resolveEdgesForSignature(
                    callerId,
                    method.calls,
                    file,
                    fileNodeLookup,
                    symbolLookup
                );
                unresolvedCalls.push(...result.unresolvedCalls);
                edges.push(...result.edges);
            }
        }
    }

    return {
        edges,
        unresolvedCalls
    };
}

function resolveEdgesForSignature(
    callerId: string,
    calls: FunctionCall[],
    file: FileStructure,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>,
    symbolLookup: Map<string, FunctionNode[]>
): { edges: FunctionEdge[]; unresolvedCalls: FunctionCall[] } {
    const edges: FunctionEdge[] = [];
    const unresolvedCalls: FunctionCall[] = [];

    for (const call of calls) {
        const resolution = resolveCall(call, file, fileNodeLookup, symbolLookup);

        if (!resolution.isResolved || resolution.to.startsWith('unresolved::')) {
            unresolvedCalls.push(call);
            continue;
        }

        edges.push({
            from: callerId,
            to: resolution.to,
            callLine: call.line,
            callExpression: call.callee,
            isResolved: true
        });
    }

    return { edges, unresolvedCalls };
}

function resolveCall(
    call: FunctionCall,
    file: FileStructure,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>,
    symbolLookup: Map<string, FunctionNode[]>
): { to: string; isResolved: boolean } {
    const containerMatch = resolveContainerPattern(call, file, fileNodeLookup);
    if (containerMatch) {
        return containerMatch;
    }

    const namesToTry = uniqueNames([call.callee, stripObjectPrefix(call.callee)]);

    for (const candidateName of namesToTry) {
        const sameFileMatch = resolveSameFile(candidateName, file.filePath, fileNodeLookup);
        if (sameFileMatch) {
            return sameFileMatch;
        }

        const importMatch = resolveViaImports(candidateName, file, fileNodeLookup);
        if (importMatch) {
            return importMatch;
        }
    }

    for (const candidateName of namesToTry) {
        const globalMatch = resolveGlobal(candidateName, symbolLookup);
        if (globalMatch) {
            return globalMatch;
        }
    }

    return {
        to: `unresolved::${call.callee}`,
        isResolved: false
    };
}

function resolveContainerPattern(
    call: FunctionCall,
    file: FileStructure,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>
): { to: string; isResolved: boolean } | null {
    const expr = call.fullExpression || '';
    
    // Match patterns like:
    // self.container.listing_assistant.generate_draft
    // self.artifact_manager.save_artifact
    // self.coordinator.run_mission
    const containerMatch = expr.match(
        /self\.(?:container\.)?(\w+)\.(\w+)/
    );
    
    if (!containerMatch) return null;
    
    const objectName = containerMatch[1];  // e.g. 'listing_assistant'
    const methodName = containerMatch[2];  // e.g. 'generate_draft'
    
    // Look up objectName in the file's imports and constructor params
    // to find which file it comes from
    // Check if any imported file contains a class with this method
    for (const [filePath, nodesByName] of fileNodeLookup) {
        const methodCandidates = nodesByName.get(methodName.toLowerCase());
        if (methodCandidates && methodCandidates.length > 0) {
            // Check if the file name or class name matches objectName
            const fileName = path.basename(filePath, path.extname(filePath));
            if (fileName.includes(objectName.replace(/_/g, '')) ||
                fileName.includes(objectName.split('_')[0])) {
                return {
                    to: methodCandidates[0].id,
                    isResolved: true
                };
            }
        }
    }
    
    return null;
}

function resolveSameFile(
    functionName: string,
    filePath: string,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>
): { to: string; isResolved: boolean } | null {
    const byName = fileNodeLookup.get(path.normalize(filePath));
    const candidates = byName?.get(functionName.toLowerCase()) ?? [];

    if (candidates.length === 1) {
        return { to: candidates[0].id, isResolved: true };
    }

    if (candidates.length > 1) {
        return { to: `unresolved::${functionName}`, isResolved: false };
    }

    return null;
}

function resolveViaImports(
    functionName: string,
    file: FileStructure,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>
): { to: string; isResolved: boolean } | null {
    const normalizedName = functionName.toLowerCase();

    for (const imported of file.imports) {
        if (!imported.importedNames.some(name => name.toLowerCase() === normalizedName)) {
            continue;
        }

        const resolvedPath = imported.resolvedPath ? path.normalize(imported.resolvedPath) : null;
        if (!resolvedPath) {
            return { to: `unresolved::${functionName}`, isResolved: false };
        }

        const candidates = fileNodeLookup.get(resolvedPath)?.get(normalizedName) ?? [];
        if (candidates.length === 1) {
            return { to: candidates[0].id, isResolved: true };
        }

        if (candidates.length > 1) {
            return { to: `unresolved::${functionName}`, isResolved: false };
        }

        const fallbackCandidate = resolveImportByFileMatch(imported, normalizedName, fileNodeLookup);
        if (fallbackCandidate) {
            return fallbackCandidate;
        }
    }

    return null;
}

function resolveImportByFileMatch(
    imported: ImportReference,
    normalizedName: string,
    fileNodeLookup: Map<string, Map<string, FunctionNode[]>>
): { to: string; isResolved: boolean } | null {
    const resolvedPath = imported.resolvedPath ? path.normalize(imported.resolvedPath) : null;
    if (!resolvedPath) {
        return null;
    }

    const byName = fileNodeLookup.get(resolvedPath);
    if (!byName) {
        return null;
    }

    const candidates = byName.get(normalizedName) ?? [];
    if (candidates.length === 1) {
        return { to: candidates[0].id, isResolved: true };
    }

    if (candidates.length > 1) {
        return { to: `unresolved::${normalizedName}`, isResolved: false };
    }

    return null;
}

function resolveGlobal(
    functionName: string,
    symbolLookup: Map<string, FunctionNode[]>
): { to: string; isResolved: boolean } | null {
    const candidates = symbolLookup.get(functionName.toLowerCase()) ?? [];

    if (candidates.length === 1) {
        return { to: candidates[0].id, isResolved: true };
    }

    if (candidates.length > 1) {
        return { to: `unresolved::${functionName}`, isResolved: false };
    }

    return null;
}

function buildSymbolLookup(nodes: FunctionNode[]): Map<string, FunctionNode[]> {
    const lookup = new Map<string, FunctionNode[]>();

    for (const node of nodes) {
        const key = node.functionName.toLowerCase();
        const existing = lookup.get(key) ?? [];
        existing.push(node);
        lookup.set(key, existing);
    }

    return lookup;
}

function buildFileNodeLookup(nodes: FunctionNode[]): Map<string, Map<string, FunctionNode[]>> {
    const lookup = new Map<string, Map<string, FunctionNode[]>>();

    for (const node of nodes) {
        const normalizedFilePath = path.normalize(node.filePath);
        const byName = lookup.get(normalizedFilePath) ?? new Map<string, FunctionNode[]>();
        const key = node.functionName.toLowerCase();
        const existing = byName.get(key) ?? [];
        existing.push(node);
        byName.set(key, existing);
        lookup.set(normalizedFilePath, byName);
    }

    return lookup;
}

function buildNodeId(filePath: string, functionName: string, className?: string): string {
    const normalizedFilePath = path.normalize(filePath);
    return className
        ? `${normalizedFilePath}::${className}.${functionName}`
        : `${normalizedFilePath}::${functionName}`;
}

function stripObjectPrefix(callee: string): string {
    const segments = callee.split('.');
    return segments.length > 1 ? segments[segments.length - 1] : callee;
}

function uniqueNames(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
}
