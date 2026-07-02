import * as path from 'path';
import { FlowExtractor } from '../comprehension/callGraph/flowExtractor';
import { BehavioralPathSearcher, BehavioralSearchResult } from '../comprehension/behavioralPathSearcher';
import { UnderstandingHealthService } from '../comprehension/understandingHealthService';
import {
    BehavioralPath,
    FlowContext,
    FlowContextBlock,
    FunctionNode
} from '../comprehension/types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FlowReliability {
    reliable: boolean;
    caveat?: string;
    source: 'call_graph' | 'behavioral_path' | 'merged' | 'none';
    completeness: 'complete' | 'partial' | 'unavailable';
    gaps: string[];
}

export interface EnrichedFlowContext {
    flowContext: FlowContext | null;
    reliability: FlowReliability;
    /** Pre-formatted path context for the prompt (includes branches, errors). */
    formattedPathContext?: string;
}

// ── Builder ────────────────────────────────────────────────────────────────

export class FlowContextBuilder {
    constructor(
        private flowExtractor: FlowExtractor | null,
        private behavioralPathSearcher: BehavioralPathSearcher | undefined,
        private healthService: UnderstandingHealthService | undefined,
        private outputChannel?: { appendLine(msg: string): void }
    ) {}

    build(question: string, flowTraversalEnabled: boolean): EnrichedFlowContext {
        // 1. Check health
        const healthCheck = this.healthService?.getReliabilityForIntent('flow');
        const healthUnreliable = healthCheck && !healthCheck.reliable;

        if (!flowTraversalEnabled) {
            return {
                flowContext: null,
                reliability: {
                    reliable: !healthUnreliable,
                    source: 'none',
                    completeness: 'unavailable',
                    gaps: [],
                    caveat: healthCheck?.caveatMessage
                }
            };
        }

        // 2. Try call graph first
        let callGraphFlow: FlowContext | null = null;
        const callGraphGaps: string[] = [];

        if (this.flowExtractor) {
            callGraphFlow = this.flowExtractor.extractFlow(question);
            if (callGraphFlow) {
                // Check for unresolved edges / partial traces
                if (callGraphFlow.chain.maxDepthReached) {
                    callGraphGaps.push(`Max traversal depth reached (${callGraphFlow.chain.depth} levels) — deeper calls not traced`);
                }
                // Check for nodes with no outbound but that aren't terminal
                const lastNode = callGraphFlow.chain.nodes[callGraphFlow.chain.nodes.length - 1];
                if (lastNode && lastNode.outboundCalls.length > 0) {
                    const unresolvedOutbound = lastNode.outboundCalls.filter(
                        callId => !callGraphFlow!.chain.nodes.some(n => n.id === callId)
                    );
                    if (unresolvedOutbound.length > 0) {
                        callGraphGaps.push(
                            `Trace ends at ${lastNode.functionName}() — ${unresolvedOutbound.length} outbound call(s) not followed`
                        );
                    }
                }
                this.outputChannel?.appendLine(
                    `[Info] Flow extraction (call graph): ${callGraphFlow.chain.nodes.length} functions traced from ${callGraphFlow.matchedEntryPoint}`
                );
            }
        }

        // 3. Try behavioral paths
        let behavioralResult: BehavioralSearchResult | null = null;
        let behavioralPath: BehavioralPath | null = null;

        if (this.behavioralPathSearcher) {
            const results = this.behavioralPathSearcher.search(question, 1);
            if (results.length > 0 && results[0].score >= 0.25) {
                behavioralResult = results[0];
                behavioralPath = behavioralResult.path;
                this.outputChannel?.appendLine(
                    `[Info] Flow extraction (behavioral path): ${behavioralPath.entryPointSymbol} ` +
                    `(score ${behavioralResult.score.toFixed(2)}, confidence ${behavioralPath.confidence.toFixed(2)})`
                );
            }
        }

        // 4. Merge / select best source
        if (callGraphFlow && behavioralPath) {
            return this.buildMergedContext(callGraphFlow, callGraphGaps, behavioralPath, behavioralResult!, healthUnreliable, healthCheck?.caveatMessage);
        }

        if (callGraphFlow) {
            return this.buildCallGraphContext(callGraphFlow, callGraphGaps, healthUnreliable, healthCheck?.caveatMessage);
        }

        if (behavioralPath && behavioralResult) {
            return this.buildBehavioralContext(behavioralPath, behavioralResult, healthUnreliable, healthCheck?.caveatMessage);
        }

        // 5. Nothing found
        return {
            flowContext: null,
            reliability: {
                reliable: false,
                source: 'none',
                completeness: 'unavailable',
                gaps: ['No matching entry point found in call graph or behavioral paths'],
                caveat: healthUnreliable
                    ? healthCheck?.caveatMessage
                    : 'No flow trace available for this query — answer will rely on code search only.'
            }
        };
    }

    private buildCallGraphContext(
        flow: FlowContext,
        gaps: string[],
        healthUnreliable: boolean | undefined,
        caveat?: string
    ): EnrichedFlowContext {
        const completeness = gaps.length > 0 ? 'partial' as const : 'complete' as const;
        return {
            flowContext: this.annotateFlowBlocks(flow, 'TRACED'),
            reliability: {
                reliable: !healthUnreliable && completeness === 'complete',
                source: 'call_graph',
                completeness,
                gaps,
                caveat: healthUnreliable ? caveat : undefined
            }
        };
    }

    private buildBehavioralContext(
        bp: BehavioralPath,
        result: BehavioralSearchResult,
        healthUnreliable: boolean | undefined,
        caveat?: string
    ): EnrichedFlowContext {
        const flowContext = behavioralPathToFlowContext(bp, result);
        const gaps: string[] = [];
        const isLowConfidence = bp.confidence < 0.5;

        if (isLowConfidence) {
            gaps.push(`Behavioral path confidence is ${bp.confidence.toFixed(2)} — steps are LLM-inferred, not statically traced`);
        }
        if (bp.asyncBoundaries.length > 0) {
            for (const ab of bp.asyncBoundaries) {
                gaps.push(`Async boundary at ${ab.symbol}: ${ab.description}`);
            }
        }

        const formattedPathContext = formatBehavioralPathContext(bp);

        return {
            flowContext,
            reliability: {
                reliable: !healthUnreliable && !isLowConfidence,
                source: 'behavioral_path',
                completeness: isLowConfidence ? 'partial' : 'complete',
                gaps,
                caveat: healthUnreliable ? caveat : undefined
            },
            formattedPathContext
        };
    }

    private buildMergedContext(
        flow: FlowContext,
        callGraphGaps: string[],
        bp: BehavioralPath,
        bpResult: BehavioralSearchResult,
        healthUnreliable: boolean | undefined,
        caveat?: string
    ): EnrichedFlowContext {
        // Use call graph as primary, enrich with behavioral path context
        const annotatedFlow = this.annotateFlowBlocks(flow, 'TRACED');
        const formattedPathContext = formatBehavioralPathContext(bp);
        const gaps = [...callGraphGaps];

        if (bp.confidence < 0.5) {
            gaps.push(`Supplementary behavioral path confidence is ${bp.confidence.toFixed(2)}`);
        }

        return {
            flowContext: annotatedFlow,
            reliability: {
                reliable: !healthUnreliable && callGraphGaps.length === 0,
                source: 'merged',
                completeness: callGraphGaps.length > 0 ? 'partial' : 'complete',
                gaps,
                caveat: healthUnreliable ? caveat : undefined
            },
            formattedPathContext
        };
    }

    private annotateFlowBlocks(flow: FlowContext, tag: string): FlowContext {
        return {
            ...flow,
            contextBlocks: flow.contextBlocks.map(block => ({
                ...block,
                callsNext: block.callsNext ? `${block.callsNext}  [${tag}]` : `[${tag}]`
            }))
        };
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function behavioralPathToFlowContext(bp: BehavioralPath, result: BehavioralSearchResult): FlowContext {
    const entryNode: FunctionNode = {
        id: bp.entryPointId,
        filePath: bp.entryPointFile,
        functionName: bp.entryPointSymbol,
        className: undefined,
        startLine: 0,
        endLine: 10,
        isExported: true,
        isEntryPoint: true,
        outboundCalls: [],
        inboundCalls: [],
        callCount: 0,
        importance: 1
    };

    const nodes: FunctionNode[] = bp.happyPath.map(s => ({
        id: s.symbol,
        filePath: s.relativePath,
        functionName: s.symbol,
        className: undefined,
        startLine: 0,
        endLine: 10,
        isExported: true,
        isEntryPoint: false,
        outboundCalls: [],
        inboundCalls: [],
        callCount: 0,
        importance: 0
    }));

    const tag = bp.confidence >= 0.5 ? 'PRE-TRACED' : 'INFERRED';
    const contextBlocks: FlowContextBlock[] = bp.happyPath.map((s, i) => ({
        filePath: s.relativePath,
        functionName: s.symbol,
        startLine: 0,
        endLine: 10,
        bodyPreview: s.description || s.symbol,
        callsNext: i < bp.happyPath.length - 1
            ? `calls ${bp.happyPath[i + 1].symbol}() in ${path.basename(bp.happyPath[i + 1].relativePath)}  [${tag}]`
            : `returns result  [${tag}]`,
        depth: i
    }));

    return {
        question: '',
        matchedEntryPoint: bp.entryPointSymbol,
        chain: {
            entryPoint: entryNode,
            nodes,
            edges: [],
            depth: bp.callTreeDepth,
            maxDepthReached: false
        },
        contextBlocks
    };
}

function formatBehavioralPathContext(bp: BehavioralPath): string {
    const lines: string[] = [];
    lines.push('EXECUTION PATH (pre-traced behavioral path):');
    for (const s of bp.happyPath) {
        lines.push(
            `  Step ${s.step}: ${s.symbol} in ${path.basename(s.relativePath)}` +
            (s.description ? ` — ${s.description}` : '')
        );
    }

    if (bp.branches.length > 0) {
        lines.push('BRANCHES:');
        for (const b of bp.branches) {
            lines.push(`  Branch at ${b.atSymbol} (if ${b.condition}): true→${b.truePath}, false→${b.falsePath}`);
        }
    }

    if (bp.errorPaths.length > 0) {
        lines.push('ERROR PATHS:');
        for (const e of bp.errorPaths) {
            lines.push(`  Error (trigger: ${e.triggerCondition}): Handled at ${e.handledAt} → ${e.outcome}`);
        }
    }

    if (bp.asyncBoundaries.length > 0) {
        lines.push('ASYNC BOUNDARIES:');
        for (const ab of bp.asyncBoundaries) {
            lines.push(`  ${ab.symbol}: ${ab.description}`);
        }
    }

    return lines.join('\n');
}
