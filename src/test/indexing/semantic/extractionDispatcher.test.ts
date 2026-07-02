import { suite, test } from 'mocha';
import * as assert from 'assert';
import { ExtractionDispatcher } from '../../../indexing/semantic/extractionDispatcher';
import { SemanticProvider, SemanticExtractionResult } from '../../../indexing/semantic/semanticProviderContract';

class MockProvider implements SemanticProvider {
    public readonly name = 'mock';
    public readonly version = '1.0';

    public canHandle(filePath: string): boolean {
        return filePath.endsWith('.mock');
    }

    public async extract(filePath: string, content: string): Promise<SemanticExtractionResult> {
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

suite('ExtractionDispatcher', () => {
    test('routes to registered provider', async () => {
        const dispatcher = new ExtractionDispatcher();
        dispatcher.registerProvider(new MockProvider());

        assert.strictEqual(dispatcher.canHandle('test.mock'), true);
        const result = await dispatcher.extract('test.mock', 'content');
        assert.ok(result);
        assert.strictEqual(result.status, 'SUCCESS');
    });

    test('returns null for unhandled files', async () => {
        const dispatcher = new ExtractionDispatcher();
        dispatcher.registerProvider(new MockProvider());

        assert.strictEqual(dispatcher.canHandle('test.ts'), false);
        const result = await dispatcher.extract('test.ts', 'content');
        assert.strictEqual(result, null);
    });
});
