import { FactStore } from '../store/factStore';
import { FactRecord } from '../indexing/factTypes';

export type UsageClassification = 'Actionable' | 'Safe' | 'Noise' | 'Unknown';

export interface UsageEvaluation {
    classification: UsageClassification;
    reasoning: string;
    evidence: FactRecord[];
}

export class UsageHeuristicEvaluator {
    constructor(private factStore: FactStore) {}

    async evaluateUsage(consumerNodeId: string, targetSymbolName: string, edgeType: string): Promise<UsageEvaluation> {
        // If it's a structural usage edge based on AST, it's actionable
        if (edgeType === 'calls_method' || edgeType === 'implements_interface' || edgeType === 'instantiates') {
            return {
                classification: 'Actionable',
                reasoning: `Contains explicit AST reference to ${targetSymbolName} via ${edgeType}`,
                evidence: []
            };
        }
        
        if (edgeType === 'imports') {
            return {
                classification: 'Safe',
                reasoning: `Imports ${targetSymbolName} but does not use it structurally (no method calls, instantiations, or inheritance)`,
                evidence: []
            };
        }
        
        if (edgeType === 'reads' || edgeType === 'assigns') {
            return {
                classification: 'Actionable',
                reasoning: `Directly reads or assigns ${targetSymbolName}`,
                evidence: []
            };
        }

        if (edgeType === 'calls') {
             return {
                classification: 'Actionable',
                reasoning: `Directly calls function ${targetSymbolName}`,
                evidence: []
            };
        }
        
        if (edgeType === 'references') {
            return {
                classification: 'Actionable',
                reasoning: `Directly references ${targetSymbolName}`,
                evidence: []
            };
        }

        return {
            classification: 'Unknown',
            reasoning: `Edge type ${edgeType} has obscured static traceability`,
            evidence: []
        };
    }
}
