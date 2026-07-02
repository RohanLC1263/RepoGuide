import { suite, test } from 'mocha';
import * as assert from 'assert';
import { ExtractionCoordinator } from '../../../indexing/semantic/extractionCoordinator';
import { ExtractionExecutionPolicy, ExtractionMode } from '../../../indexing/semantic/extractionExecutionPolicy';
import { ExtractionDispatcher } from '../../../indexing/semantic/extractionDispatcher';
import { SemanticProvider, SemanticExtractionResult } from '../../../indexing/semantic/semanticProviderContract';
import { LogicalUnit } from '../../../indexing/logicalUnitTypes';

class MockSemanticProvider implements SemanticProvider {
    public readonly name = 'mock';
    public readonly version = '1.0';
    public called = false;

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.ts');
    }

    public async extract(filePath: string, content: string): Promise<SemanticExtractionResult> {
        this.called = true;
        return {
            status: 'SUCCESS',
            providerMetadata: {
                providerName: this.name,
                providerVersion: this.version,
                extractionMethod: 'compiler',
                extractionTimestampMs: 123
            },
            entities: [],
            relationships: [],
            knownUnknowns: [],
            diagnostics: [],
            metrics: {
                durationMs: 0,
                filesProcessed: 1,
                entitiesExtracted: 0,
                relationshipsExtracted: 0,
                unknownsFound: 0
            }
        };
    }
}

suite('ExtractionCoordinator', () => {
    test('ShadowMode executes both but returns lexical', async () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.ShadowMode);

        const dispatcher = new ExtractionDispatcher();
        const provider = new MockSemanticProvider();
        dispatcher.registerProvider(provider);

        let legacyCalled = false;
        const legacyExtractor = async (): Promise<LogicalUnit[]> => {
            legacyCalled = true;
            return [{
                id: '1',
                type: 'function',
                symbol: 'foo',
                filePath: 'test.ts',
                language: 'typescript',
                content: 'foo()',
                startLine: 1,
                endLine: 2,
                role: 'unknown',
                parseStatus: 'complete',
                extractionMethod: 'tree_sitter',
                metadata: { confidence: 'high' }
            }];

        };

        const coordinator = new ExtractionCoordinator(policy, dispatcher, legacyExtractor);
        const result = await coordinator.extractFile('test.ts', 'content', '/root');

        assert.strictEqual(provider.called, true);
        assert.strictEqual(legacyCalled, true);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].symbol, 'foo');
    });

    test('Lexical mode skips semantic completely', async () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.LexicalOnly);

        const dispatcher = new ExtractionDispatcher();
        const provider = new MockSemanticProvider();
        dispatcher.registerProvider(provider);

        let legacyCalled = false;
        const legacyExtractor = async (): Promise<LogicalUnit[]> => {
            legacyCalled = true;
            return [];
        };

        const coordinator = new ExtractionCoordinator(policy, dispatcher, legacyExtractor);
        await coordinator.extractFile('test.ts', 'content', '/root');

        assert.strictEqual(provider.called, false);
        assert.strictEqual(legacyCalled, true);
    });
});
