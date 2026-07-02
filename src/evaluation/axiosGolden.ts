import { EvidenceTestCase } from './evidenceGoldenTypes';

export const axiosGoldenCases: EvidenceTestCase[] = [
    {
        id: 'AX-01',
        description: 'Core Concept',
        query: 'What is Axios?',
        expectedSpans: [{ filePattern: 'Axios.js', symbol: 'Axios' }],
        expectedFacts: [],
        prohibitedFilePatterns: ['test', 'spec']
    },
    {
        id: 'AX-02',
        description: 'Interceptor Flow',
        query: 'How do interceptors work in Axios?',
        expectedSpans: [{ filePattern: 'InterceptorManager.js', symbol: 'InterceptorManager' }],
        expectedFacts: [],
        prohibitedFilePatterns: ['test', 'spec']
    },
    {
        id: 'AX-03',
        description: 'Headers parsing',
        query: 'What is AxiosHeaders responsible for?',
        expectedSpans: [{ filePattern: 'AxiosHeaders.js', symbol: 'AxiosHeaders' }],
        expectedFacts: [],
        prohibitedFilePatterns: ['test', 'spec']
    },
    {
        id: 'AX-04',
        description: 'Request Dispatch',
        query: 'Trace a request from API call to network dispatch.',
        expectedSpans: [{ filePattern: 'dispatchRequest.js', symbol: 'dispatchRequest' }],
        expectedFacts: [],
        prohibitedFilePatterns: ['test', 'spec']
    },
    {
        id: 'AX-05',
        description: 'Adapter logic',
        query: 'How are HTTP adapters chosen?',
        expectedSpans: [{ filePattern: 'adapters', symbol: 'getAdapter' }],
        expectedFacts: [],
        prohibitedFilePatterns: ['test', 'spec']
    }
];
