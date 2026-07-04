import { describe, test, expect } from '@jest/globals';
import { scoreQuestion } from '../../evaluation/scorers';
import { GoldenQuestion, PipelineQuestionOutput } from '../../evaluation/types';
import { FlowArtifactState } from '../../evaluation/flowArtifactInspector';

const workspaceRoot = '/workspace';
const flowArtifacts: FlowArtifactState = { behavioralPaths: null, callGraph: null };

function makeQuestion(overrides: Partial<GoldenQuestion> = {}): GoldenQuestion {
    return {
        id: 'q1',
        type: 'explanation',
        question: 'What does Client::builder do?',
        expectedAnswer: 'It constructs a ClientBuilder.',
        requiresLocations: false,
        ...overrides
    };
}

function makeOutput(answer: string, citedFiles: string[] = []): PipelineQuestionOutput {
    return {
        answer,
        controlEvents: { navigationResults: [] },
        capturedContext: {
            retrievedChunkIds: citedFiles.length ? ['chunk-1'] : [],
            retrievedArtifacts: [],
            topCitedFiles: citedFiles,
            citedFiles: []
        },
        confidence: null,
        rawAnswerContexts: []
    };
}

describe('scoreProvenanceAccuracy (heuristic, real verification against representative answer shapes)', () => {
    test('scores 2: real citation present, synthesis language properly hedged', () => {
        const question = makeQuestion();
        const output = makeOutput(
            'The code in src/async_impl/client.rs shows that Client::builder() calls ClientBuilder::new() directly. ' +
            'This likely exists as a more discoverable entry point, based on the naming convention used elsewhere.',
            ['src/async_impl/client.rs']
        );
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBe(2);
    });

    test('scores 1: a real citation is present, but synthesis-shaped language elsewhere in the answer is stated with no hedge -- inference presented as fact alongside real evidence', () => {
        const question = makeQuestion();
        const output = makeOutput(
            'The code in src/async_impl/client.rs shows that Client::builder() calls ClientBuilder::new(). ' +
            'The overall architecture typically follows this same builder pattern throughout the codebase.',
            ['src/async_impl/client.rs']
        );
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBe(1);
    });

    test('scores 1: no direct citation, but the answer appropriately hedges', () => {
        const question = makeQuestion();
        const output = makeOutput(
            'It probably delegates to a constructor, though I cannot confirm without seeing the exact implementation.'
        );
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBe(1);
    });

    test('scores 0: no citation and no hedge -- confident, unattributed claim', () => {
        const question = makeQuestion();
        const output = makeOutput(
            'Client::builder always validates the TLS configuration before returning.'
        );
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBe(0);
    });

    test('returns null for uncertainty questions -- handled by scoreHonestUncertainty instead', () => {
        const question = makeQuestion({ type: 'uncertainty', uncertaintyExpectation: { shouldAdmitUnknown: true } });
        const output = makeOutput('This is not something built into the library.');
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBeNull();
    });

    test('returns null for staleness questions -- handled by scoreStalenessHandling instead', () => {
        const question = makeQuestion({ type: 'staleness' });
        const output = makeOutput('This file was recently modified and the index may be stale.');
        const result = scoreQuestion({ question, output, flowArtifacts, workspaceRoot });
        expect(result.scores.provenanceAccuracy).toBeNull();
    });
});
