import { EvidencePacket } from '../query/evidencePacket';
import { EvidenceTestCase, EvidenceGateResults } from './evidenceGoldenTypes';

export function scoreEvidencePacket(testCase: EvidenceTestCase, packet: EvidencePacket): EvidenceGateResults {
    const diagnostics: string[] = [];
    
    // Gate 1: Span Retrieval
    let gate1SpanPassed = true;
    let totalExpectedSpans = testCase.expectedSpans.length;
    let foundExpectedSpans = 0;
    
    // Check Spans
    if (totalExpectedSpans > 0) {
        for (const expected of testCase.expectedSpans) {
            const allItems = [...packet.items, ...packet.facts];
            const found = allItems.some(item => {
                const fileMatches = new RegExp(expected.filePattern, 'i').test(item.file);
                const symbolMatches = expected.symbol ? item.symbol === expected.symbol || item.content.includes(expected.symbol) : true;
                return fileMatches && symbolMatches;
            });
            if (!found) {
                gate1SpanPassed = false;
                diagnostics.push(`Gate 1 Failed: Missing expected span (file: ${expected.filePattern}, symbol: ${expected.symbol || 'any'})`);
            } else {
                foundExpectedSpans++;
            }
        }
    } else {
        gate1SpanPassed = true;
    }

    // Gate 2: Exact Facts
    let gate2FactPassed = true;
    let totalExpectedFacts = testCase.expectedFacts.length;
    let foundExpectedFacts = 0;
    
    if (totalExpectedFacts > 0) {
        for (const expected of testCase.expectedFacts) {
            const found = packet.facts.some(fact => {
                const typeMatches = fact.type === expected.type;
                const symbolMatches = expected.symbol ? fact.symbol === expected.symbol : true;
                let valueMatches = true;
                if (expected.value !== undefined) {
                    if (fact.type === 'fallback_chain' || fact.type === 'instantiation') {
                        valueMatches = String(fact.content).includes(String(expected.value));
                    } else if (fact.type === 'numeric_threshold' || fact.type === 'list_count') {
                        valueMatches = Number(fact.content) === Number(expected.value);
                    } else {
                        valueMatches = String(fact.content) === String(expected.value);
                    }
                }
                if (['q8_symbol_location', 'q2_list_count', 'q4_dependency_injection', 'q6_config_surface', 'q10_test_leak_check'].includes(testCase.id)) {
                    // console.log(`${testCase.id} candidate fact:`, fact, 'expected value:', expected.value);
                }
                return typeMatches && symbolMatches && valueMatches;
            });
            if (!found) {
                gate2FactPassed = false;
                diagnostics.push(`Gate 2 Failed: Missing expected fact (type: ${expected.type}, symbol: ${expected.symbol || 'any'})`);
            } else {
                foundExpectedFacts++;
            }
        }
    } else {
        gate2FactPassed = true;
    }

    // Gap check
    if (testCase.expectGap) {
        const hasGap = packet.gaps.length > 0;
        if (!hasGap) {
            gate1SpanPassed = false;
            gate2FactPassed = false;
            diagnostics.push(`Failed: Expected a structured gap but none was reported.`);
        }
    }

    // Test Leak Check
    let testLeak = false;
    for (const item of [...packet.items, ...packet.facts]) {
        for (const prohibited of testCase.prohibitedFilePatterns) {
            if (new RegExp(prohibited, 'i').test(item.file)) {
                testLeak = true;
                diagnostics.push(`Test Leak Failed: Prohibited file pattern '${prohibited}' matched retrieved file '${item.file}'`);
            }
        }
    }
    
    const K = Math.max(packet.items.length + packet.facts.length, 1);
    const relevantFound = foundExpectedSpans + foundExpectedFacts;
    const totalExpected = totalExpectedSpans + totalExpectedFacts;
    
    const evidencePrecisionAtK = relevantFound / K;
    const evidenceRecallAtK = totalExpected > 0 ? relevantFound / totalExpected : 1;
    const requiredEvidenceCoverage = totalExpected > 0 ? relevantFound / totalExpected : 1;
    const constantExpansionFired = packet.facts.some(f => f.type === 'constant');

    let failureMode: EvidenceGateResults['failureMode'] = 'none';
    if (testLeak) {
        failureMode = 'test_leak';
    } else if (testCase.expectGap && packet.gaps.length === 0) {
        failureMode = 'gap_failure';
    } else if (!gate2FactPassed) {
        failureMode = 'missing_fact';
    } else if (!gate1SpanPassed) {
        failureMode = 'missing_span';
    }

    return {
        caseId: testCase.id,
        gate1SpanPassed,
        gate2FactPassed,
        testLeak,
        diagnostics,
        packet,
        evidencePrecisionAtK,
        evidenceRecallAtK,
        requiredEvidenceCoverage,
        constantExpansionFired,
        answerGatePass: false, // populated later
        unsupportedClaimRate: 0, // populated later
        numericAccuracy: 0, // populated later
        failureMode,
        mentorEvaluated: false,
        mentorPass: true
    };
}

import { GateResult } from '../query/answerGate';

export function scoreAnswerGate(gateResult: GateResult, evidenceResult: EvidenceGateResults, testCase?: EvidenceTestCase): EvidenceGateResults {
    const totalClaims = gateResult.supported_claims.length + gateResult.unsupported_claims.length;
    const unsupportedClaimRate = totalClaims > 0 ? gateResult.unsupported_claims.length / totalClaims : 0;
    
    const numericSupported = gateResult.supported_claims.filter(c => c.startsWith('Numeric')).length;
    const numericUnsupported = gateResult.unsupported_claims.filter(c => c.startsWith('Numeric')).length;
    const totalNumeric = numericSupported + numericUnsupported;
    const numericAccuracy = totalNumeric > 0 ? numericSupported / totalNumeric : 1;
    
    let answerGatePass = gateResult.outcome === 'pass';
    if (testCase?.expectedAnswerGateOutcome === 'blocked_or_revised') {
        answerGatePass = gateResult.outcome !== 'pass';
    }
    
    let failureMode = evidenceResult.failureMode;
    if (failureMode === 'none' && !answerGatePass) {
        if (gateResult.diagnostics.some(d => d.includes('Unsupported numeric') || d.includes('Unsupported quoted'))) {
            if (gateResult.diagnostics.some(d => d.includes('Unsupported quoted'))) {
                failureMode = 'hallucinated_quote';
            } else {
                failureMode = 'unsupported_claim';
            }
        } else if (gateResult.diagnostics.some(d => d.includes('Answer lacked gap phrasing'))) {
            failureMode = 'gap_failure';
        } else {
            failureMode = 'other';
        }
    }
    
    const newDiagnostics = [...evidenceResult.diagnostics, ...gateResult.diagnostics.map(d => `AnswerGate: ${d}`)];
    
    return {
        ...evidenceResult,
        answerGatePass,
        unsupportedClaimRate,
        numericAccuracy,
        failureMode,
        diagnostics: newDiagnostics
    };
}
