import { suite, test } from 'mocha';
import * as assert from 'assert';
import { CliRenderer } from '../../../../indexing/semantic/evaluation/renderers/cliRenderer';
import { JsonRenderer } from '../../../../indexing/semantic/evaluation/renderers/jsonRenderer';
import { MarkdownRenderer } from '../../../../indexing/semantic/evaluation/renderers/markdownRenderer';
import { EvaluationResult } from '../../../../indexing/semantic/evaluation/evaluationModels';

suite('Dashboard Renderers', () => {
    
    const mockResult: EvaluationResult = {
        evaluationId: 'eval-123',
        timestampMs: 123456789,
        fixtureId: 'fixture-abc',
        candidateIdentifier: 'test-cand',
        providerQuality: { precision: 0.8, recall: 0.9, falsePositives: 2, falseNegatives: 1 },
        repositoryBrainQuality: { knowledgeCoverage: 0.9, knownUnknownCalibration: 0.8, reasoningReadinessScore: 0.85 },
        capabilityResults: [
            { capabilityId: 'cap_declarations', precision: 1.0, recall: 1.0, truePositives: 10, falsePositives: 0, falseNegatives: 0 }
        ],
        extractionMetrics: { durationMs: 10, filesProcessed: 1, entitiesExtracted: 10, relationshipsExtracted: 0, unknownsFound: 0 },
        findings: [
            { id: 'find-1', severity: 'warning', category: 'Extraction Error', recommendation: 'Check entity' }
        ]
    };

    test('CliRenderer output', () => {
        const renderer = new CliRenderer();
        const output = renderer.render(mockResult) as string;
        assert.ok(output.includes('SEMANTIC REGRESSION DASHBOARD'));
        assert.ok(output.includes('eval-123'));
        assert.ok(output.includes('Precision: 80.0%'));
        assert.ok(output.includes('[cap_declarations]'));
        assert.ok(output.includes('[WARNING] Extraction Error: Check entity'));
    });

    test('JsonRenderer output', () => {
        const renderer = new JsonRenderer();
        const output = renderer.render(mockResult) as string;
        const parsed = JSON.parse(output);
        assert.strictEqual(parsed.evaluationId, 'eval-123');
        assert.strictEqual(parsed.providerQuality.precision, 0.8);
    });

    test('MarkdownRenderer output', () => {
        const renderer = new MarkdownRenderer();
        const output = renderer.render(mockResult) as string;
        assert.ok(output.includes('# Semantic Regression Dashboard'));
        assert.ok(output.includes('`eval-123`'));
        assert.ok(output.includes('80.0%'));
        assert.ok(output.includes('cap_declarations'));
        assert.ok(output.includes('**[Extraction Error]** Check entity'));
    });
});
