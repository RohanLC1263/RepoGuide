import test from 'node:test';
import * as assert from 'node:assert/strict';
import { INFERENCE_MODEL_OPTIONS, PLANNING_MODEL_OPTIONS } from '../../ollama/inferencer';

/**
 * Reproducibility is a measurement requirement for this project, not a nicety:
 * every before/after pass-rate comparison assumes the same input yields the same
 * output. `temperature: 0` alone does not deliver that from Ollama -- with the seed
 * unset it is drawn per request, and a byte-identical prompt was measured producing
 * four distinct answer texts across six runs.
 */

test('both model configs pin temperature AND seed', () => {
    for (const [name, options] of [
        ['INFERENCE_MODEL_OPTIONS', INFERENCE_MODEL_OPTIONS],
        ['PLANNING_MODEL_OPTIONS', PLANNING_MODEL_OPTIONS]
    ] as const) {
        assert.equal(options.temperature, 0, `${name}.temperature must be 0`);
        assert.equal(typeof options.seed, 'number', `${name}.seed must be pinned, not left to Ollama`);
    }
});

test('the two configs share one seed, so planning and synthesis stay in step', () => {
    assert.equal(INFERENCE_MODEL_OPTIONS.seed, PLANNING_MODEL_OPTIONS.seed);
});
