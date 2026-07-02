import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildEvidencePlan } from '../query/evidencePlanner';

test('Evidence Planner', () => {
    // - threshold queries produce threshold fact requirements.
    const thresholdPlan = buildEvidencePlan('What is the maximum retry limit?');
    assert.equal(thresholdPlan.queryType, 'threshold');
    assert.ok(thresholdPlan.factTypes.includes('numeric_threshold'));
    assert.ok(thresholdPlan.mustExcludeRoles.includes('test'));
    assert.ok(thresholdPlan.mustExcludeRoles.includes('generated'));

    // - "how many" list queries produce list_count requirements.
    const listPlan = buildEvidencePlan('How many items are in DEFAULT_ITEMS?');
    assert.equal(listPlan.queryType, 'list_count');
    assert.ok(listPlan.factTypes.includes('list_count'));

    // - fallback-order queries produce fallback_chain requirements.
    const fallbackPlan = buildEvidencePlan('What is the fallback failover order?');
    assert.equal(fallbackPlan.queryType, 'fallback_chain');
    assert.ok(fallbackPlan.factTypes.includes('fallback_chain'));

    // - dependency/injection queries produce instantiation/DI requirements.
    const diPlan = buildEvidencePlan('How is the Database injected into the Service constructor?');
    assert.equal(diPlan.queryType, 'dependency_injection');
    assert.ok(diPlan.factTypes.includes('dependency_injection'));

    // - "where is X initialized" produces symbol_location plus instantiation requirements.
    const locationPlan = buildEvidencePlan('Where is the Worker initialized?');
    assert.equal(locationPlan.queryType, 'symbol_location');
    assert.ok(locationPlan.factTypes.includes('instantiation'));

    // - test-focused queries allow test scope.
    const testPlan = buildEvidencePlan('How is the Worker mock tested?');
    assert.equal(testPlan.queryType, 'test_query');
    assert.equal(testPlan.mustExcludeRoles.length, 0); // Allows tests

    // - ordinary implementation queries exclude tests/generated.
    const implPlan = buildEvidencePlan('How does the Router work?');
    assert.equal(implPlan.queryType, 'behavior_explanation');
    assert.ok(implPlan.mustExcludeRoles.includes('test'));
    assert.ok(implPlan.mustExcludeRoles.includes('generated'));
    assert.equal(implPlan.fileScope, 'implementation_only');

    // - unknown queries produce a conservative plan with structured gaps.
    const unknownPlan = buildEvidencePlan('florp blorp');
    assert.equal(unknownPlan.queryType, 'unknown');
    assert.ok(unknownPlan.requiredEvidence.includes('structured gaps'));
});
