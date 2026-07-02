import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { unwrapArtifact, wrapArtifact } from '../comprehension/schema-versions';
import { RuntimeEdge, RuntimeTracesSchema, TraceFormat } from './traceIngestionService';

type OutputLogger = { appendLine(message: string): void };

interface DynamicCallEdge {
    id: string;
    from: { relativePath: string | null; symbol: string | null };
    to: { relativePath: string | null; symbol: string | null };
    type: 'dynamic';
    source: TraceFormat;
    confidence: number;
    observedCount: number;
    hot_path: boolean;
    reviewRequired: boolean;
    reason: string;
}

interface DynamicCallGraph {
    schemaVersion: '1.0';
    builtAt: string;
    edges: DynamicCallEdge[];
    stats: {
        dynamicEdges: number;
        hotPaths: number;
        reviewRequired: number;
    };
}

interface ReconcileSummary {
    confirmedEdges: number;
    dynamicEdgesAdded: number;
    divergentBehavioralPaths: number;
    coverageVerifiedFunctions: number;
}

interface PathStepRef {
    index: number;
    step: any;
    relativePath: string | null;
    symbol: string | null;
}

export class RuntimeStaticReconciler implements vscode.Disposable {
    private readonly commandDisposable: vscode.Disposable;

    constructor(
        private readonly workspaceRoot: string,
        private readonly understandingDir: string,
        private readonly outputChannel?: OutputLogger
    ) {
        this.commandDisposable = vscode.commands.registerCommand('repoguide.reconcileRuntimeTraces', async () => {
            await this.reconcile();
        });
    }

    dispose(): void {
        this.commandDisposable.dispose();
    }

    public async reconcile(): Promise<ReconcileSummary> {
        const traces = this.readArtifact<RuntimeTracesSchema>('runtime_traces.json');
        const summary: ReconcileSummary = {
            confirmedEdges: 0,
            dynamicEdgesAdded: 0,
            divergentBehavioralPaths: 0,
            coverageVerifiedFunctions: 0
        };

        if (!traces) {
            this.outputChannel?.appendLine('[Info] Runtime reconciliation: no runtime_traces.json found.');
            return summary;
        }

        const callGraph = this.readArtifact<any>('call_graph_v2.json') ?? emptyCallGraph();
        const confirmation = this.confirmStaticEdges(callGraph, traces.runtimeEdges ?? []);
        summary.confirmedEdges = confirmation.confirmedEdges;
        this.writeArtifact('call_graph_v2.json', callGraph);
        this.outputChannel?.appendLine(`[Info] Call graph: ${summary.confirmedEdges} edges runtime-confirmed`);

        const dynamicGraph = this.readArtifact<DynamicCallGraph>('dynamic_call_graph.json') ?? emptyDynamicCallGraph();
        summary.dynamicEdgesAdded = this.addDynamicEdges(dynamicGraph, confirmation.unmatchedRuntimeEdges);
        this.writeDynamicCallGraph(dynamicGraph);

        const behavior = this.enrichBehavioralPaths(traces.runtimeEdges ?? []);
        summary.divergentBehavioralPaths = behavior.divergentPaths;

        summary.coverageVerifiedFunctions = this.applyCoverageVerification(traces.verifiedLines ?? {});

        this.outputChannel?.appendLine(
            `[Info] Runtime reconciliation: ${summary.confirmedEdges} edges confirmed, ` +
            `${summary.dynamicEdgesAdded} dynamic edges added, ` +
            `${summary.divergentBehavioralPaths} behavioral paths have runtime divergence (flagged for review), ` +
            `${summary.coverageVerifiedFunctions} functions coverage-verified`
        );

        return summary;
    }

    private confirmStaticEdges(
        callGraph: any,
        runtimeEdges: RuntimeEdge[]
    ): { confirmedEdges: number; unmatchedRuntimeEdges: RuntimeEdge[] } {
        if (!Array.isArray(callGraph.edges)) {
            callGraph.edges = [];
        }

        let confirmedEdges = 0;
        const matchedRuntimeKeys = new Set<string>();
        const staticByKey = new Map<string, any[]>();

        for (const edge of callGraph.edges) {
            const key = edgeKey(endpointFromStaticEdge(edge, 'from', this.workspaceRoot), endpointFromStaticEdge(edge, 'to', this.workspaceRoot));
            if (!key) {
                continue;
            }
            const bucket = staticByKey.get(key) ?? [];
            bucket.push(edge);
            staticByKey.set(key, bucket);
        }

        for (const runtimeEdge of runtimeEdges) {
            const key = edgeKey(runtimeEdge.from, runtimeEdge.to);
            if (!key) {
                continue;
            }
            const staticEdges = staticByKey.get(key);
            if (!staticEdges || staticEdges.length === 0) {
                continue;
            }

            matchedRuntimeKeys.add(key);
            for (const staticEdge of staticEdges) {
                if (!staticEdge.runtime_confirmed) {
                    confirmedEdges += 1;
                }
                const currentConfidence = clampConfidence(Number(staticEdge.confidence ?? 0.5));
                staticEdge.confidence = clampConfidence(currentConfidence + Math.min(0.15, 1.0 - currentConfidence));
                staticEdge.runtime_confirmed = true;
                staticEdge.runtimeObservedCount = (staticEdge.runtimeObservedCount ?? 0) + (runtimeEdge.observedCount ?? 1);
                staticEdge.runtimeSource = runtimeEdge.source;
                if ((runtimeEdge.observedCount ?? 0) > 10) {
                    staticEdge.hot_path = true;
                }
            }
        }

        callGraph.builtAt = new Date().toISOString();
        const unmatchedRuntimeEdges = runtimeEdges.filter(edge => {
            const key = edgeKey(edge.from, edge.to);
            return key && !matchedRuntimeKeys.has(key);
        });

        return { confirmedEdges, unmatchedRuntimeEdges };
    }

    private addDynamicEdges(dynamicGraph: DynamicCallGraph, runtimeEdges: RuntimeEdge[]): number {
        let added = 0;
        const existing = new Map(dynamicGraph.edges.map(edge => [edge.id, edge]));

        for (const runtimeEdge of runtimeEdges) {
            const id = dynamicEdgeId(runtimeEdge);
            const current = existing.get(id);
            if (current) {
                current.observedCount += runtimeEdge.observedCount ?? 1;
                current.hot_path = current.hot_path || current.observedCount > 10;
                current.confidence = Math.max(current.confidence, dynamicConfidence(runtimeEdge));
                continue;
            }

            const dynamicEdge: DynamicCallEdge = {
                id,
                from: normalizeEndpoint(runtimeEdge.from),
                to: normalizeEndpoint(runtimeEdge.to),
                type: 'dynamic',
                source: runtimeEdge.source,
                confidence: dynamicConfidence(runtimeEdge),
                observedCount: runtimeEdge.observedCount ?? 1,
                hot_path: (runtimeEdge.observedCount ?? 0) > 10,
                reviewRequired: true,
                reason: 'Runtime trace observed this call, but static call_graph_v2 has no matching edge.'
            };
            dynamicGraph.edges.push(dynamicEdge);
            existing.set(id, dynamicEdge);
            added += 1;

            this.outputChannel?.appendLine(
                `[Warn] Dynamic call found: ${formatEndpoint(dynamicEdge.from)} -> ` +
                `${formatEndpoint(dynamicEdge.to)} (not in static graph)`
            );
        }

        dynamicGraph.builtAt = new Date().toISOString();
        dynamicGraph.stats = {
            dynamicEdges: dynamicGraph.edges.length,
            hotPaths: dynamicGraph.edges.filter(edge => edge.hot_path).length,
            reviewRequired: dynamicGraph.edges.filter(edge => edge.reviewRequired).length
        };
        return added;
    }

    private enrichBehavioralPaths(runtimeEdges: RuntimeEdge[]): { divergentPaths: number } {
        const behavioralPaths = this.readArtifact<any>('behavioral_paths.json');
        if (!behavioralPaths || !Array.isArray(behavioralPaths.paths)) {
            return { divergentPaths: 0 };
        }

        const runtimeEdgeKeys = new Set(runtimeEdges.map(edge => edgeKey(edge.from, edge.to)).filter((key): key is string => Boolean(key)));
        const hotEdgeKeys = new Set(
            runtimeEdges
                .filter(edge => (edge.observedCount ?? 0) > 10)
                .map(edge => edgeKey(edge.from, edge.to))
                .filter((key): key is string => Boolean(key))
        );

        let divergentPaths = 0;
        let changed = false;

        for (const behaviorPath of behavioralPaths.paths) {
            const steps = collectHappyPathSteps(behaviorPath);
            if (steps.length === 0) {
                continue;
            }

            let pathConfirmed = false;
            let hotPath = false;
            let diverged = false;

            for (let i = 0; i < steps.length; i += 1) {
                const current = steps[i];
                const next = steps[i + 1];
                if (!next) {
                    continue;
                }
                const adjacentKey = edgeKey(current, next);
                if (adjacentKey && runtimeEdgeKeys.has(adjacentKey)) {
                    current.step.runtime_confirmed = true;
                    next.step.runtime_confirmed = true;
                    pathConfirmed = true;
                    changed = true;
                }
                if (adjacentKey && hotEdgeKeys.has(adjacentKey)) {
                    current.step.hot_path = true;
                    next.step.hot_path = true;
                    hotPath = true;
                    changed = true;
                }
            }

            const stepIndexByEndpoint = new Map<string, number>();
            for (const step of steps) {
                const key = endpointKey(step);
                if (key) {
                    stepIndexByEndpoint.set(key, step.index);
                }
            }

            for (const edge of runtimeEdges) {
                const fromIndex = stepIndexByEndpoint.get(endpointKey(edge.from) ?? '');
                const toIndex = stepIndexByEndpoint.get(endpointKey(edge.to) ?? '');
                if (fromIndex === undefined || toIndex === undefined) {
                    continue;
                }
                if (toIndex <= fromIndex || toIndex !== fromIndex + 1) {
                    diverged = true;
                }
            }

            if (pathConfirmed) {
                behaviorPath.runtime_confirmed = true;
            }
            if (hotPath) {
                behaviorPath.hot_path = true;
            }
            if (diverged) {
                if (!behaviorPath.runtime_divergence) {
                    divergentPaths += 1;
                }
                behaviorPath.runtime_divergence = true;
                behaviorPath.reviewRequired = true;
                changed = true;
            }
        }

        if (changed) {
            this.writeArtifact('behavioral_paths.json', behavioralPaths);
        }

        return { divergentPaths };
    }

    private applyCoverageVerification(verifiedLines: Record<string, number[]>): number {
        const lexicalMap = this.readArtifact<any>('lexical_map.json');
        if (!lexicalMap?.files) {
            return 0;
        }

        const coverageVerifiedByFile = new Map<string, Set<string>>();
        let verifiedFunctions = 0;
        let lexicalChanged = false;

        for (const [fileKey, entry] of Object.entries<any>(lexicalMap.files)) {
            const relativePath = normalizeRelativePath(entry.filePath ?? fileKey, this.workspaceRoot);
            const executedLines = verifiedLines[relativePath];
            if (!executedLines || !Array.isArray(entry.symbols)) {
                continue;
            }
            const executed = new Set(executedLines);
            for (const symbol of entry.symbols) {
                if (!isFunctionLike(symbol)) {
                    continue;
                }
                const startLine = Number(symbol.startLine);
                const endLine = Number(symbol.endLine);
                if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine) {
                    continue;
                }
                if (!rangeFullyCovered(startLine, endLine, executed)) {
                    continue;
                }
                if (!symbol.coverage_verified) {
                    verifiedFunctions += 1;
                }
                symbol.coverage_verified = true;
                symbol.runtimeVerified = true;
                symbol.coverageVerifiedAt = new Date().toISOString();
                const names = coverageVerifiedByFile.get(relativePath) ?? new Set<string>();
                names.add(symbol.name);
                coverageVerifiedByFile.set(relativePath, names);
                lexicalChanged = true;
            }
        }

        if (lexicalChanged) {
            this.writeArtifact('lexical_map.json', lexicalMap);
        }

        this.updateFileUnderstandingConfidence(coverageVerifiedByFile);
        return verifiedFunctions;
    }

    private updateFileUnderstandingConfidence(verifiedByFile: Map<string, Set<string>>): void {
        if (verifiedByFile.size === 0) {
            return;
        }

        const files = this.readArtifact<any[]>('files.json');
        if (Array.isArray(files)) {
            let changed = false;
            for (const fileUnderstanding of files) {
                const relativePath = normalizeRelativePath(fileUnderstanding.filePath ?? fileUnderstanding.relativePath, this.workspaceRoot);
                if (!verifiedByFile.has(relativePath)) {
                    continue;
                }
                fileUnderstanding.confidence ??= {};
                const current = clampConfidence(Number(fileUnderstanding.confidence.purpose ?? 0.5));
                fileUnderstanding.confidence.purpose = clampConfidence(current + 0.05);
                fileUnderstanding.coverage_verified_symbols = Array.from(verifiedByFile.get(relativePath) ?? []);
                changed = true;
            }
            if (changed) {
                this.writeArtifact('files.json', files);
            }
        }

        const filesDir = path.join(this.understandingDir, 'files');
        if (!fs.existsSync(filesDir)) {
            return;
        }
        for (const entry of fs.readdirSync(filesDir)) {
            if (!entry.endsWith('.json')) {
                continue;
            }
            const filePath = path.join(filesDir, entry);
            const fileUnderstanding = readJsonFile<any>(filePath);
            const relativePath = normalizeRelativePath(fileUnderstanding?.filePath ?? fileUnderstanding?.relativePath, this.workspaceRoot);
            if (!relativePath || !verifiedByFile.has(relativePath)) {
                continue;
            }
            fileUnderstanding.confidence ??= {};
            const current = clampConfidence(Number(fileUnderstanding.confidence.purpose ?? 0.5));
            fileUnderstanding.confidence.purpose = clampConfidence(current + 0.05);
            fileUnderstanding.coverage_verified_symbols = Array.from(verifiedByFile.get(relativePath) ?? []);
            writeJsonFile(filePath, fileUnderstanding);
        }
    }

    private readArtifact<T>(artifactName: string): T | null {
        return unwrapArtifact<T>(readJsonFile(path.join(this.understandingDir, artifactName)));
    }

    private writeArtifact<T>(artifactName: string, data: T): void {
        const artifactPath = path.join(this.understandingDir, artifactName);
        const existing = readJsonFile<any>(artifactPath);
        writePossiblyWrappedArtifact(artifactPath, artifactName, existing, data);
    }

    private writeDynamicCallGraph(dynamicGraph: DynamicCallGraph): void {
        this.writeArtifact('dynamic_call_graph.json', dynamicGraph);
    }
}

function emptyCallGraph(): any {
    return {
        schemaVersion: '2.0',
        builtAt: new Date().toISOString(),
        edges: [],
        unresolved: [],
        reverseIndex: {},
        stats: {
            totalCallSites: 0,
            resolved: 0,
            unresolved: 0,
            resolutionRate: 0
        }
    };
}

function emptyDynamicCallGraph(): DynamicCallGraph {
    return {
        schemaVersion: '1.0',
        builtAt: new Date().toISOString(),
        edges: [],
        stats: {
            dynamicEdges: 0,
            hotPaths: 0,
            reviewRequired: 0
        }
    };
}

function endpointFromStaticEdge(edge: any, side: 'from' | 'to', workspaceRoot: string): { relativePath: string | null; symbol: string | null } {
    if (side === 'from') {
        if (edge.caller) {
            return {
                relativePath: normalizeNullablePath(edge.caller.relativePath ?? edge.caller.filePath, workspaceRoot),
                symbol: stringOrNull(edge.caller.symbol ?? edge.caller.functionName ?? edge.caller.name)
            };
        }
        const parsed = parseCompoundEndpoint(edge.from ?? edge.source);
        return {
            relativePath: normalizeNullablePath(parsed.relativePath ?? edge.callerFile ?? edge.sourceFilePath, workspaceRoot),
            symbol: parsed.symbol ?? stringOrNull(edge.callerSymbol)
        };
    }

    if (edge.callee) {
        return {
            relativePath: normalizeNullablePath(edge.callee.relativePath ?? edge.callee.filePath, workspaceRoot),
            symbol: stringOrNull(edge.callee.symbol ?? edge.callee.functionName ?? edge.callee.name)
        };
    }
    const parsed = parseCompoundEndpoint(edge.to ?? edge.target);
    return {
        relativePath: normalizeNullablePath(parsed.relativePath ?? edge.calleeFile ?? edge.targetFilePath, workspaceRoot),
        symbol: parsed.symbol ?? stringOrNull(edge.calleeSymbol)
    };
}

function parseCompoundEndpoint(value: unknown): { relativePath: string | null; symbol: string | null } {
    if (typeof value !== 'string') {
        return { relativePath: null, symbol: null };
    }
    const separator = value.includes('::') ? '::' : ':';
    const index = value.lastIndexOf(separator);
    if (index < 0) {
        return { relativePath: value, symbol: null };
    }
    return {
        relativePath: value.slice(0, index),
        symbol: value.slice(index + separator.length) || null
    };
}

function edgeKey(
    from: { relativePath: string | null; symbol: string | null },
    to: { relativePath: string | null; symbol: string | null }
): string | null {
    const fromKey = endpointKey(from);
    const toKey = endpointKey(to);
    return fromKey && toKey ? `${fromKey}->${toKey}` : null;
}

function endpointKey(endpoint: { relativePath: string | null; symbol: string | null }): string | null {
    const symbol = endpoint.symbol?.trim().toLowerCase();
    if (!symbol) {
        return null;
    }
    return `${(endpoint.relativePath ?? '').replace(/\\/g, '/').toLowerCase()}:${symbol}`;
}

function normalizeEndpoint(endpoint: { relativePath: string | null; symbol: string | null }): { relativePath: string | null; symbol: string | null } {
    return {
        relativePath: endpoint.relativePath ? endpoint.relativePath.replace(/\\/g, '/') : null,
        symbol: endpoint.symbol
    };
}

function dynamicEdgeId(edge: RuntimeEdge): string {
    return `${edge.source}:${edgeKey(edge.from, edge.to) ?? `${formatEndpoint(edge.from)}->${formatEndpoint(edge.to)}`}`;
}

function dynamicConfidence(edge: RuntimeEdge): number {
    return Math.max(0.88, clampConfidence(edge.confidence ?? 0.88));
}

function collectHappyPathSteps(behaviorPath: any): PathStepRef[] {
    if (!Array.isArray(behaviorPath.happyPath)) {
        return [];
    }
    return behaviorPath.happyPath.map((step: any, index: number) => ({
        index,
        step,
        relativePath: normalizeStepPath(step),
        symbol: stringOrNull(step.symbol ?? step.functionName ?? step.name)
    }));
}

function normalizeStepPath(step: any): string | null {
    return stringOrNull(step.relativePath ?? step.filePath)?.replace(/\\/g, '/') ?? null;
}

function rangeFullyCovered(startLine: number, endLine: number, executed: Set<number>): boolean {
    for (let line = startLine; line <= endLine; line += 1) {
        if (!executed.has(line)) {
            return false;
        }
    }
    return true;
}

function isFunctionLike(symbol: any): boolean {
    return symbol?.kind === 'function' || symbol?.kind === 'method' || symbol?.kind === 'constructor';
}

function formatEndpoint(endpoint: { relativePath: string | null; symbol: string | null }): string {
    return `${endpoint.relativePath ?? 'unknown'}:${endpoint.symbol ?? 'unknown'}`;
}

function normalizeNullablePath(value: unknown, workspaceRoot: string): string | null {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return normalizeRelativePath(value, workspaceRoot);
}

function normalizeRelativePath(value: unknown, workspaceRoot: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        return '';
    }
    const relative = path.isAbsolute(value) ? path.relative(workspaceRoot, value) : value;
    return path.normalize(relative).replace(/\\/g, '/').replace(/^\.\//, '');
}

function clampConfidence(value: number): number {
    if (!Number.isFinite(value)) {
        return 0.5;
    }
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function writeJsonFile(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writePossiblyWrappedArtifact<T>(
    filePath: string,
    artifactName: string,
    existingRaw: any,
    data: T
): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (existingRaw && typeof existingRaw === 'object' && 'data' in existingRaw) {
        existingRaw.data = data;
        existingRaw.updatedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(existingRaw, null, 2), 'utf8');
        return;
    }
    fs.writeFileSync(filePath, JSON.stringify(wrapArtifact(artifactName, data), null, 2), 'utf8');
}
