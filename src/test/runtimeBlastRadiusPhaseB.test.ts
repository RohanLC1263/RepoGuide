import { RuntimeBlastRadiusCalculator, BlastRadiusCalculationResult, BlastRadiusExplanation } from '../runtime/blast_radius/runtimeBlastRadiusCalculator';
import * as assert from 'assert';

class MockQueryEngine {
    constructor(private paths: Record<string, string[][]>, private confidences: Record<string, number>, private types: Record<string, string>) {}

    getTransitiveDependents(source: string, depth: number) {
        const targets = new Set<string>();
        const sourcePaths = this.paths[source] || [];
        for (const p of sourcePaths) {
            targets.add(p[p.length - 1]);
        }
        return Array.from(targets);
    }

    getAllDependencyPaths(source: string, target: string) {
        return (this.paths[source] || []).filter(p => p[p.length - 1] === target);
    }

    getDependencyConfidence(to: string, from: string) {
        return this.confidences[`${from}->${to}`] !== undefined ? this.confidences[`${from}->${to}`] : 1.0;
    }

    getDependencyType(to: string, from: string) {
        return this.types[`${from}->${to}`] || 'HARD_DEPENDENCY';
    }
}

async function runTests() {
    console.log("Running T_B1: Exponential Decay Validation");
    const engine1 = new MockQueryEngine({
        'S1': [
            ['S1', 'Hop1'],
            ['S1', 'Hop1', 'Hop2', 'Hop3', 'Hop4', 'Hop5'],
            ['S1', 'Hop1', 'Hop2', 'Hop3', 'Hop4', 'Hop5', 'Hop6', 'Hop7', 'Hop8', 'Hop9', 'Hop10']
        ]
    }, {}, {});
    const calc1 = new RuntimeBlastRadiusCalculator(engine1 as any);
    const res1 = calc1.calculate('cycle1', [{ component_id: 'S1', riskScore: 1.0 }]);
    const getRes = (arr: any[], t: string) => arr.find(a => a.target_component_id === t)!.blast_radius_score;
    assert.strictEqual(getRes(res1, 'Hop1'), 1.0, "T_B1 Failed: Hop 1");
    assert.strictEqual(getRes(res1, 'Hop5').toFixed(4), Math.pow(0.85, 4).toFixed(4), "T_B1 Failed: Hop 5");
    assert.strictEqual(getRes(res1, 'Hop10').toFixed(4), Math.pow(0.85, 9).toFixed(4), "T_B1 Failed: Hop 10");

    console.log("Running T_B2: Dependency Multiplier Validation");
    const engine2 = new MockQueryEngine({
        'S1': [
            ['S1', 'HardNode'],
            ['S1', 'SoftNode'],
            ['S1', 'UnknownNode']
        ]
    }, {}, {
        'S1->HardNode': 'HARD_DEPENDENCY',
        'S1->SoftNode': 'CORRELATED_DEPENDENCY',
        'S1->UnknownNode': 'UNKNOWN'
    });
    const calc2 = new RuntimeBlastRadiusCalculator(engine2 as any);
    const res2 = calc2.calculate('cycle2', [{ component_id: 'S1', riskScore: 1.0 }]);
    assert.strictEqual(getRes(res2, 'HardNode'), 1.0, "T_B2 Failed: Hard");
    assert.strictEqual(getRes(res2, 'SoftNode'), 0.3, "T_B2 Failed: Soft");
    assert.strictEqual(getRes(res2, 'UnknownNode'), 0.1, "T_B2 Failed: Unknown");

    console.log("Running T_B3 & T_B5: Probabilistic Union & Multi-Source Validation");
    const engine3 = new MockQueryEngine({
        'S1': [['S1', 'Target']],
        'S2': [['S2', 'Target']]
    }, {}, {});
    const calc3 = new RuntimeBlastRadiusCalculator(engine3 as any);
    const res3 = calc3.calculate('cycle3', [
        { component_id: 'S1', riskScore: 0.5 },
        { component_id: 'S2', riskScore: 0.5 }
    ]);
    assert.strictEqual(getRes(res3, 'Target'), 0.75, "T_B3 Failed: Probabilistic Union");

    console.log("Running T_B4: Maximum Path Envelope Validation");
    const engine4 = new MockQueryEngine({
        'S1': [
            ['S1', 'B', 'Target'],
            ['S1', 'C', 'Target']
        ]
    }, {
        'S1->B': 1.0, 'B->Target': 1.0,
        'S1->C': 0.5, 'C->Target': 1.0
    }, {});
    const calc4 = new RuntimeBlastRadiusCalculator(engine4 as any);
    const res4 = calc4.calculate('cycle4', [{ component_id: 'S1', riskScore: 1.0 }]);
    assert.strictEqual(getRes(res4, 'Target'), 0.85, "T_B4 Failed: Path Envelope Deduplication");

    console.log("Running T_B6: Explainability Payload Validation");
    const explObj: BlastRadiusExplanation = JSON.parse(res4.find(r => r.target_component_id === 'Target')!.explanation_json);
    assert.strictEqual(explObj.orchestratorCycleId, 'cycle4');
    assert.strictEqual(explObj.finalAggregatedRisk, 0.85);
    assert.strictEqual(explObj.unionCalculation, '1 - (1-0.85)');
    assert.strictEqual(explObj.contributingSources.length, 1);
    assert.strictEqual(explObj.contributingSources[0].source, 'S1');
    assert.deepStrictEqual(explObj.contributingSources[0].envelopePath, ['S1', 'B', 'Target']);
    assert.deepStrictEqual(explObj.contributingSources[0].dependencyTypes, ['HARD_DEPENDENCY', 'HARD_DEPENDENCY']);

    console.log("All Phase B tests passed!");
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
