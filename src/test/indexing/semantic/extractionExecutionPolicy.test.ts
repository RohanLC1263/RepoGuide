import { suite, test } from 'mocha';
import * as assert from 'assert';
import { ExtractionExecutionPolicy, ExtractionMode } from '../../../indexing/semantic/extractionExecutionPolicy';

suite('ExtractionExecutionPolicy', () => {
    test('ShadowMode returns correct strategy', () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.ShadowMode);

        const strategy = policy.determineStrategy('test.ts', true);
        assert.strictEqual(strategy.executeLexical, true);
        assert.strictEqual(strategy.executeSemantic, true);
        assert.strictEqual(strategy.authoritativeResult, 'lexical');
    });

    test('LexicalOnly returns correct strategy', () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.LexicalOnly);

        const strategy = policy.determineStrategy('test.ts', true);
        assert.strictEqual(strategy.executeLexical, true);
        assert.strictEqual(strategy.executeSemantic, false);
        assert.strictEqual(strategy.authoritativeResult, 'lexical');
    });

    test('SemanticOnly returns correct strategy', () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.SemanticOnly);

        const strategy = policy.determineStrategy('test.ts', true);
        assert.strictEqual(strategy.executeLexical, false);
        assert.strictEqual(strategy.executeSemantic, true);
        assert.strictEqual(strategy.authoritativeResult, 'semantic');
    });

    test('falls back to lexical if semantic cannot handle', () => {
        const policy = new ExtractionExecutionPolicy();
        policy.setMode(ExtractionMode.ShadowMode);

        const strategy = policy.determineStrategy('test.rs', false);
        assert.strictEqual(strategy.executeLexical, true);
        assert.strictEqual(strategy.executeSemantic, false);
        assert.strictEqual(strategy.authoritativeResult, 'lexical');
    });
});
