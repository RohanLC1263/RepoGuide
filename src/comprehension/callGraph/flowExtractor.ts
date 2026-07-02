import * as path from 'path';
import * as vscode from 'vscode';
import {
    CallChain,
    FlowContext,
    FlowContextBlock,
    FunctionCallGraph,
    FunctionNode
} from '../types';
import { CallGraphTraverser } from './callGraphTraverser';

const STOP_WORDS = new Set([
    'about', 'after', 'again', 'against', 'between', 'could', 'from', 'into',
    'their', 'there', 'these', 'those', 'through', 'under', 'until', 'where',
    'which', 'while', 'with', 'would', 'this', 'that', 'what', 'when', 'your',
    'have', 'does', 'than', 'then', 'they', 'them', 'were', 'been', 'being',
    'will', 'shall', 'just', 'show', 'tell', 'explain', 'flow', 'code'
]);

export class FlowExtractor {
    constructor(
        private graph: FunctionCallGraph,
        private traverser: CallGraphTraverser,
        private outputChannel?: vscode.OutputChannel
    ) {}

    extractFlow(question: string): FlowContext | null {
        const entryPoint = this.findEntryPoint(question);
        if (!entryPoint) {
            this.outputChannel?.appendLine('[Info] Flow extractor: no entry point match found.');
            return null;
        }

        const chain = this.traverser.traverse(entryPoint.id);
        if (!chain) {
            this.outputChannel?.appendLine('[Info] Flow extractor: traversal returned no chain.');
            return null;
        }

        return {
            question,
            matchedEntryPoint: entryPoint.id,
            chain,
            contextBlocks: this.buildFlowContext(chain, question)
        };
    }

    findEntryPoint(question: string): FunctionNode | null {
        const terms = extractTerms(question);
        const allNodes = Object.values(this.graph.nodes);
        if (terms.length === 0) {
            return allNodes
                .filter(node => node.isEntryPoint)
                .sort((left, right) => right.importance - left.importance)[0] ?? null;
        }

        const rankedNodes = allNodes
            .map(node => ({
                node,
                score: this.scoreMatch(node, terms)
            }))
            .filter(result => result.score > 2)
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                if (left.node.isEntryPoint !== right.node.isEntryPoint) {
                    return left.node.isEntryPoint ? -1 : 1;
                }
                return right.node.inboundCalls.length - left.node.inboundCalls.length;
            });

        return rankedNodes[0]?.node
            ?? allNodes
                .filter(node => node.isEntryPoint)
                .sort((left, right) => right.importance - left.importance)[0]
            ?? null;
    }

    buildFlowContext(chain: CallChain, _question: string): FlowContextBlock[] {
        return chain.nodes.map((node, index) => {
            const nextNode = chain.nodes[index + 1];
            const nextEdge = nextNode
                ? chain.edges.find(edge => edge.from === node.id && edge.to === nextNode.id)
                : null;

            const callsNext = nextNode
                ? nextEdge
                    ? `calls ${nextNode.functionName}() in ${path.basename(nextNode.filePath)}`
                    : `flows to ${nextNode.functionName}() in ${path.basename(nextNode.filePath)}`
                : 'returns result';

            return {
                filePath: node.filePath,
                functionName: node.functionName,
                startLine: node.startLine,
                endLine: node.endLine,
                bodyPreview: node.bodyPreview ?? '',
                callsNext,
                depth: index
            };
        });
    }

    scoreMatch(node: FunctionNode, terms: string[]): number {
        const functionName = node.functionName.toLowerCase();
        const filePath = node.filePath.toLowerCase();
        const docstring = (node.docstring ?? '').toLowerCase();
        const bodyPreview = (node.bodyPreview ?? '').toLowerCase();

        let score = 0;

        for (const term of terms) {
            if (functionName.includes(term)) {
                score += 3;
            }
            if (filePath.includes(term)) {
                score += 2;
            }
            if (docstring.includes(term)) {
                score += 2;
            }
            if (bodyPreview.includes(term)) {
                score += 1;
            }
        }

        if (node.isEntryPoint) {
            score += 2;
        }

        score += Math.min(node.inboundCalls.length, 5);

        return score;
    }
}

function extractTerms(question: string): string[] {
    const matches = question.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    return Array.from(new Set(matches.filter(term => term.length > 3 && !STOP_WORDS.has(term))));
}
