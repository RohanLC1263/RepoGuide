import * as path from 'path';
import * as fs from 'fs';

export interface FlowArtifactState {
    behavioralPaths: any | null;
    callGraph: any | null;
}

export function loadFlowArtifacts(understandingDir: string): FlowArtifactState {
    let behavioralPaths = null;
    let callGraph = null;

    try {
        const bpPath = path.join(understandingDir, 'behavioral_paths.json');
        if (fs.existsSync(bpPath)) {
            behavioralPaths = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
        }
    } catch (e) {
        // Handle gracefully
    }

    try {
        const cgPath = path.join(understandingDir, 'call_graph_v2.json');
        if (fs.existsSync(cgPath)) {
            callGraph = JSON.parse(fs.readFileSync(cgPath, 'utf8'));
        }
    } catch (e) {
        // Handle gracefully
    }

    return { behavioralPaths, callGraph };
}

function normalizePath(p: string, workspaceRoot: string): string {
    const normalized = p.replace(/\\/g, '/').toLowerCase();
    const root = workspaceRoot.replace(/\\/g, '/').toLowerCase();
    return normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized;
}

export function flowArtifactsContainExpectedPath(
    state: FlowArtifactState,
    files: string[],
    symbols: string[],
    workspaceRoot: string
): { score: 0 | 1 | 2; notes: string[] } {
    const notes: string[] = [];
    const expectedFiles = new Set(files.map(f => normalizePath(f, workspaceRoot)));
    const expectedSymbols = new Set(symbols.map(s => s.toLowerCase()));
    
    if (expectedFiles.size === 0 && expectedSymbols.size === 0) {
        return { score: 0, notes: ["No files or symbols to check in flow artifacts."] };
    }

    const matchedFiles = new Set<string>();
    const matchedSymbols = new Set<string>();

    if (state.behavioralPaths && state.behavioralPaths.paths) {
        for (const p of state.behavioralPaths.paths) {
            if (p.entryPointFile) {
                const normPath = normalizePath(p.entryPointFile, workspaceRoot);
                if (expectedFiles.has(normPath)) matchedFiles.add(normPath);
            }
            if (p.entryPointSymbol) {
                const sym = p.entryPointSymbol.toLowerCase();
                if (expectedSymbols.has(sym)) matchedSymbols.add(sym);
            }
            if (p.happyPath) {
                for (const step of p.happyPath) {
                    if (step.relativePath) {
                        const normPath = normalizePath(step.relativePath, workspaceRoot);
                        if (expectedFiles.has(normPath)) matchedFiles.add(normPath);
                    }
                    if (step.symbol) {
                        const sym = step.symbol.toLowerCase();
                        if (expectedSymbols.has(sym)) matchedSymbols.add(sym);
                    }
                }
            }
        }
    }

    if (state.callGraph && state.callGraph.data && state.callGraph.data.edges) {
        for (const edge of state.callGraph.data.edges) {
            if (edge.caller) {
                if (edge.caller.relativePath) {
                    const normPath = normalizePath(edge.caller.relativePath, workspaceRoot);
                    if (expectedFiles.has(normPath)) matchedFiles.add(normPath);
                }
                if (edge.caller.symbol) {
                    const sym = edge.caller.symbol.toLowerCase();
                    if (expectedSymbols.has(sym)) matchedSymbols.add(sym);
                }
            }
            if (edge.callee) {
                if (edge.callee.relativePath) {
                    const normPath = normalizePath(edge.callee.relativePath, workspaceRoot);
                    if (expectedFiles.has(normPath)) matchedFiles.add(normPath);
                }
                if (edge.callee.symbol) {
                    const sym = edge.callee.symbol.toLowerCase();
                    if (expectedSymbols.has(sym)) matchedSymbols.add(sym);
                }
            }
        }
    }

    const totalExpected = expectedFiles.size + expectedSymbols.size;
    const totalMatched = matchedFiles.size + matchedSymbols.size;
    
    if (totalMatched === 0) {
        notes.push("Flow artifacts did not contain any expected files or symbols.");
        return { score: 0, notes };
    }
    
    if (totalMatched >= totalExpected) {
        notes.push(`Flow artifacts contained all ${totalExpected} expected items.`);
        return { score: 2, notes };
    }

    const ratio = totalMatched / totalExpected;
    if (ratio >= 0.5) {
        notes.push(`Flow artifacts contained most expected items (${totalMatched}/${totalExpected}).`);
        return { score: 2, notes };
    }

    notes.push(`Flow artifacts contained only partial expected items (${totalMatched}/${totalExpected}).`);
    return { score: 1, notes };
}

export class FlowArtifactInspector {
    constructor(a?:any, b?:any) {}
    async inspect() { return {}; }
}
