import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsNearNumbers, NUMERIC_CLAIM_SYMBOL_WINDOW } from '../../query/numericClaimSymbols';

/**
 * Pins the symbol extraction that closes LIMITATIONS.md §3.4 ("numeric cross-check is
 * packet-bound"). The gate could only contradict a claimed number when a matching
 * `numeric_threshold` fact was already in the packet; these symbols are what the dispatcher
 * looks up so the check also fires on facts retrieval never surfaced.
 */

test('no numbers in the answer means no lookup at all', () => {
    assert.deepEqual(extractSymbolsNearNumbers('The MAX_RETRIES constant governs retries.'), []);
});

test('extracts SCREAMING_SNAKE, snake_case and CamelCase near a number', () => {
    const found = extractSymbolsNearNumbers('MAX_RETRIES is 5, min_words is 3, and RetryPolicy wraps them.');
    assert.ok(found.includes('MAX_RETRIES'));
    assert.ok(found.includes('min_words'));
    assert.ok(found.includes('RetryPolicy'));
});

test('bare lowercase prose words are not treated as symbols', () => {
    const found = extractSymbolsNearNumbers('The timeout is 30 seconds and the limit is 5.');
    assert.deepEqual(found, [], 'prose nouns would flood the lookup with noise');
});

test('symbols beyond the proximity window are excluded', () => {
    const far = 'THRESHOLD_A is 5.' + ' '.repeat(NUMERIC_CLAIM_SYMBOL_WINDOW + 50) + 'UNRELATED_CONST appears much later.';
    const found = extractSymbolsNearNumbers(far);
    assert.ok(found.includes('THRESHOLD_A'));
    assert.ok(!found.includes('UNRELATED_CONST'), 'the gate ignores facts outside its own window');
});

test('common prose acronyms are filtered out', () => {
    const found = extractSymbolsNearNumbers('The JSON payload has 3 fields, per the HTTP API spec.');
    assert.ok(!found.includes('JSON'));
    assert.ok(!found.includes('HTTP'));
    assert.ok(!found.includes('API'));
});

test('results are deduplicated', () => {
    const found = extractSymbolsNearNumbers('MAX_RETRIES is 5. MAX_RETRIES is still 5. MAX_RETRIES again 5.');
    assert.deepEqual(found.filter(s => s === 'MAX_RETRIES').length, 1);
});

test('the symbol count is capped so a pathological answer cannot spawn an unbounded query', () => {
    const many = Array.from({ length: 200 }, (_, i) => `CONST_NUM_${i} is 1`).join('. ');
    assert.ok(extractSymbolsNearNumbers(many).length <= 40);
});
