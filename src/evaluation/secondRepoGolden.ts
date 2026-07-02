import { EvidenceTestCase } from './evidenceGoldenTypes';

export const secondRepoGoldenCases: EvidenceTestCase[] = [
    {
        id: 'SR-01',
        description: 'Exact threshold/constant',
        query: 'What is the value of BIG_NUMBER_PRECISION?',
        expectedSpans: [{ filePattern: 'reconcile-inventory-reserved-quantity.ts', symbol: 'BIG_NUMBER_PRECISION' }],
        expectedFacts: [{ type: 'constant', symbol: 'BIG_NUMBER_PRECISION', value: 20 }],
        prohibitedFilePatterns: ['test', 'tests', 'spec']
    },
    {
        id: 'SR-02',
        description: 'List count',
        query: 'How many defaultAdminApiKeyFields are there?',
        expectedSpans: [{ filePattern: 'query-config.ts', symbol: 'defaultAdminApiKeyFields' }],
        expectedFacts: [{ type: 'list_count', symbol: 'defaultAdminApiKeyFields', value: 13 }],
        prohibitedFilePatterns: ['test', 'tests', 'spec']
    },
    {
        id: 'SR-03',
        description: 'Fallback or guard behavior',
        query: 'Explain the guard clause behavior for GET api keys route when apiKey is not found.',
        expectedSpans: [{ filePattern: 'route.ts', symbol: 'GET' }],
        expectedFacts: [{ type: 'guard_clause', symbol: 'GET' }],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec']
    },
    {
        id: 'SR-04',
        description: 'Class initialization location',
        query: 'How is RecoveryService initialized?',
        expectedSpans: [{ filePattern: 'recovery-service.ts' }],
        expectedFacts: [{ type: 'dependency_injection', symbol: 'RecoveryService' }],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec']
    },
    {
        id: 'SR-05',
        description: 'Orientation',
        query: 'What is the purpose of the RecoveryService?',
        expectedSpans: [{ filePattern: 'recovery-service.ts' }],
        expectedFacts: [],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec']
    }
];
