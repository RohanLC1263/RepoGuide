import test from 'node:test';
import * as assert from 'node:assert/strict';
import { buildEvidencePlan, classifyQueryType } from '../query/evidencePlanner';
import { queryTypeToCapability } from '../query/capabilityMapper';

// The mentor-appendix guard (mentorOrchestrator.run) suppresses the Change-Impact /
// Architecture-Insights appendix when the DETERMINISTIC classifier maps the query to a
// no-appendix capability ('None') even though the LLM planner labelled it impact/architecture.
// This locks in that decision: explanation questions -> 'None' (guard suppresses); genuine
// impact/architecture questions -> a real capability (guard never suppresses).
test('mentor-appendix guard: deterministic classifier suppresses explanation questions but not genuine impact/architecture questions', () => {
    const capOf = (q: string) => queryTypeToCapability(classifyQueryType(q));

    // Explanation/orientation questions -> 'None' => guard suppresses the appendix.
    assert.equal(capOf('Explain the Interview feature and how it affects the Draft Listing feature'), 'None');
    assert.equal(capOf('How does the RAGRetrieverAgent work?'), 'None');

    // Genuine impact/architecture questions -> a real capability => guard does NOT fire.
    assert.notEqual(capOf('What depends on the MissionOrchestratorAgent?'), 'None');
    assert.notEqual(capOf('What breaks if I change the StoryGenerationAgent class?'), 'None');
    assert.notEqual(capOf('What is the blast radius of changing the ArtifactManager?'), 'None');
    assert.notEqual(capOf('Give me an architecture overview of the project structure'), 'None');
});

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
