import { RuntimeDependencyQueryEngine } from '../dependencies/runtimeDependencyQueryEngine';

export interface FailingSource {
    component_id: string;
    riskScore: number;
}

export interface ExplanatoryContributingSource {
    source: string;
    envelopePath: string[];
    dependencyTypes: string[];
    sourceRisk: number;
    distanceDecayApplied: number;
    propagatedEnvelopeRisk: number;
}

export interface BlastRadiusExplanation {
    target: string;
    finalAggregatedRisk: number;
    orchestratorCycleId: string;
    unionCalculation: string;
    contributingSources: ExplanatoryContributingSource[];
}

export interface BlastRadiusCalculationResult {
    orchestrator_cycle_id: string;
    target_component_id: string;
    blast_radius_score: number;
    explanation_json: string;
}

export class RuntimeBlastRadiusCalculator {
    constructor(private queryEngine: RuntimeDependencyQueryEngine) {}

    public calculate(cycleId: string, failingSources: FailingSource[]): BlastRadiusCalculationResult[] {
        const targetMap = new Map<string, ExplanatoryContributingSource[]>();

        for (const source of failingSources) {
            // Get all possible downstream impacted components up to 10 hops
            const dependents = this.queryEngine.getTransitiveDependents(source.component_id, 10);
            
            for (const target of dependents) {
                const paths = this.queryEngine.getAllDependencyPaths(source.component_id, target);
                
                let maxEnvelopeRisk = -1;
                let bestSourceExplanation: ExplanatoryContributingSource | null = null;

                for (const path of paths) {
                    let pathRisk = source.riskScore;
                    const depTypes: string[] = [];
                    
                    for (let i = 0; i < path.length - 1; i++) {
                        const from = path[i];
                        const to = path[i+1];
                        
                        const confidence = this.queryEngine.getDependencyConfidence(to, from);
                        const depType = this.queryEngine.getDependencyType(to, from);
                        depTypes.push(depType || 'UNKNOWN');
                        
                        let typeMultiplier = 0.1; // UNKNOWN
                        if (depType === 'HARD_DEPENDENCY') typeMultiplier = 1.0;
                        else if (depType === 'CORRELATED_DEPENDENCY') typeMultiplier = 0.3;
                        
                        pathRisk = pathRisk * confidence * typeMultiplier;
                    }
                    
                    const hopCount = path.length - 1;
                    const distanceDecay = Math.pow(0.85, hopCount - 1);
                    pathRisk = pathRisk * distanceDecay;

                    if (pathRisk > maxEnvelopeRisk) {
                        maxEnvelopeRisk = pathRisk;
                        bestSourceExplanation = {
                            source: source.component_id,
                            envelopePath: path,
                            dependencyTypes: depTypes,
                            sourceRisk: source.riskScore,
                            distanceDecayApplied: Number(distanceDecay.toFixed(4)),
                            propagatedEnvelopeRisk: Number(maxEnvelopeRisk.toFixed(4))
                        };
                    }
                }

                if (bestSourceExplanation && bestSourceExplanation.propagatedEnvelopeRisk > 0) {
                    if (!targetMap.has(target)) {
                        targetMap.set(target, []);
                    }
                    targetMap.get(target)!.push(bestSourceExplanation);
                }
            }
        }

        const results: BlastRadiusCalculationResult[] = [];
        for (const [target, sources] of targetMap.entries()) {
            let totalInverseRisk = 1.0;
            const unionTerms: string[] = [];
            
            for (const src of sources) {
                totalInverseRisk *= (1.0 - src.propagatedEnvelopeRisk);
                unionTerms.push(`(1-${src.propagatedEnvelopeRisk.toFixed(2)})`);
            }
            
            const finalRisk = 1.0 - totalInverseRisk;
            
            const explanation: BlastRadiusExplanation = {
                target: target,
                finalAggregatedRisk: Number(finalRisk.toFixed(4)),
                orchestratorCycleId: cycleId,
                unionCalculation: `1 - ${unionTerms.join('*')}`,
                contributingSources: sources
            };
            
            results.push({
                orchestrator_cycle_id: cycleId,
                target_component_id: target,
                blast_radius_score: Number(finalRisk.toFixed(4)),
                explanation_json: JSON.stringify(explanation)
            });
        }

        return results;
    }
}
