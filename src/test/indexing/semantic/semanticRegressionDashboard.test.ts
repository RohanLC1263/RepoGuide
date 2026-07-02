import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SemanticRegressionDashboard } from '../../../indexing/semantic/evaluation/semanticRegressionDashboard';
import { FactEvaluationResult } from '../../../indexing/semantic/evaluation/factEvaluationModels';
import { CanonicalFactFactory } from '../../../indexing/semantic/canonicalFact';

describe('Slice 6: SemanticRegressionDashboard', () => {
    const dashboard = new SemanticRegressionDashboard();

    const emptyEvaluation: FactEvaluationResult = {
        matching: [],
        missing: [],
        unexpected: [],
        identityDrift: [],
        rejectedConstructs: []
    };

    it('Dashboard: Empty evaluation renders correct summary', () => {
        const output = dashboard.render(emptyEvaluation);
        
        assert.match(output, /SUMMARY METRICS:/);
        assert.match(output, /Legacy Facts Validated:\s+0/);
        assert.match(output, /Semantic Facts Evaluated:\s+0/);
        assert.match(output, /Matches:\s+0/);
        
        // Assert no data sections are rendered
        assert.doesNotMatch(output, /--- MISSING FACTS ---/);
        assert.doesNotMatch(output, /--- UNEXPECTED FACTS ---/);
        assert.doesNotMatch(output, /--- MATCHING FACTS ---/);
        assert.doesNotMatch(output, /--- IDENTITY DRIFT ---/);
        assert.doesNotMatch(output, /--- REJECTED CONSTRUCTS ---/);
    });

    it('Dashboard: Renders all sections when coverage exists', () => {
        const matchingFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Match', valueKind: 'string' });
        const missingFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Miss', valueKind: 'string' });
        const unexpectedFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Unexp', valueKind: 'string' });
        
        const originalDrift = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Drift', value: 'old' });
        const driftedFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Drift', value: 'new' });

        const evaluation: FactEvaluationResult = {
            matching: [matchingFact],
            missing: [missingFact],
            unexpected: [unexpectedFact],
            identityDrift: [{ original: originalDrift, drifted: driftedFact }],
            rejectedConstructs: [{ factId: 'legacy_ast', reason: 'unsupported ast' }]
        };

        const output = dashboard.render(evaluation);

        // Summary asserts
        assert.match(output, /Legacy Facts Validated:\s+3/); // matching + missing + drift
        assert.match(output, /Semantic Facts Evaluated:\s+3/); // matching + unexpected + drift
        
        // Section coverage asserts
        assert.match(output, /--- MISSING FACTS ---/);
        assert.match(output, /--- UNEXPECTED FACTS ---/);
        assert.match(output, /--- MATCHING FACTS ---/);
        assert.match(output, /--- IDENTITY DRIFT ---/);
        assert.match(output, /--- REJECTED CONSTRUCTS ---/);

        // Item rendering asserts
        assert.match(output, new RegExp(`ID: ${missingFact.factId}`));
        assert.match(output, new RegExp(`ID: ${unexpectedFact.factId}`));
        assert.match(output, new RegExp(`ID: ${originalDrift.factId}`));
        assert.match(output, new RegExp(`ID: ${driftedFact.factId}`));
        assert.match(output, /Fact ID: legacy_ast/);
    });

    it('Dashboard: Deterministic rendering', () => {
        const matchingFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Match', valueKind: 'string' });
        
        const evaluation1: FactEvaluationResult = {
            matching: [matchingFact],
            missing: [],
            unexpected: [],
            identityDrift: [],
            rejectedConstructs: []
        };

        const evaluation2: FactEvaluationResult = {
            matching: [matchingFact],
            missing: [],
            unexpected: [],
            identityDrift: [],
            rejectedConstructs: []
        };

        // Identical evaluation input must produce identical rendered output
        const output1 = dashboard.render(evaluation1);
        const output2 = dashboard.render(evaluation2);

        assert.equal(output1, output2);
    });

    it('Dashboard: Purity - does not mutate input', () => {
        const matchingFact = CanonicalFactFactory.createFact('ENTITY', { symbol: 'Match', valueKind: 'string' });
        
        const evaluation: FactEvaluationResult = {
            matching: [matchingFact],
            missing: [],
            unexpected: [],
            identityDrift: [],
            rejectedConstructs: []
        };

        const clone = JSON.parse(JSON.stringify(evaluation));
        dashboard.render(evaluation);

        assert.deepEqual(evaluation, clone);
    });

    it('Dashboard: Large evaluation', () => {
        const matching = [];
        for (let i = 0; i < 5000; i++) {
            matching.push(CanonicalFactFactory.createFact('ENTITY', { symbol: `Match_${i}`, valueKind: 'string' }));
        }

        const evaluation: FactEvaluationResult = {
            matching,
            missing: [],
            unexpected: [],
            identityDrift: [],
            rejectedConstructs: []
        };

        const output = dashboard.render(evaluation);
        assert.match(output, /Matches:\s+5000/);
        assert.match(output, /Legacy Facts Validated:\s+5000/);
    });
});
