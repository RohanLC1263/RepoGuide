import { EvidenceTestCase } from './evidenceGoldenTypes';

export const craftConnectGoldenCases: EvidenceTestCase[] = [
    {
        id: 'q1_threshold',
        description: 'Threshold exact value',
        query: 'What is the DEFAULT_THRESHOLD for auth validation?',
        expectedSpans: [{ filePattern: 'auth_validator_agent.py', symbol: 'DEFAULT_THRESHOLD' }],
        expectedFacts: [{ type: 'numeric_threshold', symbol: 'DEFAULT_THRESHOLD', value: 95 }],
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q2_list_count',
        description: 'List count exact value',
        query: 'How many VALID_MIME_TYPES are supported?',
        expectedSpans: [{ filePattern: 'image_validation.py', symbol: 'VALID_MIME_TYPES' }],
        expectedFacts: [{ type: 'list_count', symbol: 'VALID_MIME_TYPES', value: 3 }],
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q3_fallback_chain',
        description: 'Fallback chain',
        query: 'What is the fallback logic for generate_with_fallback?',
        expectedSpans: [{ filePattern: '.*', symbol: 'generate_with_fallback' }],
        expectedFacts: [{ type: 'fallback_chain', symbol: 'generate_with_fallback' }],
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q4_dependency_injection',
        description: 'Dependency injection / initialization',
        query: 'How is GlobalState initialized in config?',
        expectedSpans: [{ filePattern: 'config.py' }],
        expectedFacts: [{ type: 'instantiation', value: 'GlobalState' }],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q5_prompt_template',
        description: 'Prompt template',
        query: 'What is the INCOMING_TRANSLATION_PROMPT for the conversation agent?',
        expectedSpans: [{ filePattern: 'conversation_agent.py', symbol: 'INCOMING_TRANSLATION_PROMPT' }],
        expectedFacts: [{ type: 'prompt_template', symbol: 'INCOMING_TRANSLATION_PROMPT' }],
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q6_config_surface',
        description: 'Config surface',
        query: 'What are the configuration properties for RAGRetrievalEngine?',
        expectedSpans: [{ filePattern: 'rag_retrieval_engine.py', symbol: 'SIMILARITY_THRESHOLD' }],
        expectedFacts: [{ type: 'numeric_threshold', symbol: 'SIMILARITY_THRESHOLD' }],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
        // 1024 is not a named constant; gate correctly blocks this claim
    },
    {
        id: 'q7_long_function',
        description: 'Long function tail branch',
        query: 'What are the steps in validate_image?',
        expectedSpans: [{ filePattern: 'image_validation.py', symbol: 'validate_image' }],
        expectedFacts: [],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q8_symbol_location',
        description: 'Symbol location',
        query: 'Where is MIN_SIMILARITY_THRESHOLD defined?',
        expectedSpans: [{ filePattern: 'story_generation_agent.py', symbol: 'MIN_SIMILARITY_THRESHOLD' }],
        expectedFacts: [{ type: 'numeric_threshold', symbol: 'MIN_SIMILARITY_THRESHOLD', value: 0.30 }],
        prohibitedFilePatterns: ['test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q9_missing_symbol',
        description: 'Missing symbol gap',
        query: 'What is the value of MISSING_CRAFT_SYMBOL?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectGap: true,
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'q10_test_leak_check',
        description: 'Implementation query with tempting test-file match',
        query: 'How does VALID_MIME_TYPES get validated in implementation?',
        expectedSpans: [{ filePattern: 'image_validation.py', symbol: 'VALID_MIME_TYPES' }],
        expectedFacts: [{ type: 'list_count', symbol: 'VALID_MIME_TYPES', value: 3 }],
        expectedAnswerGateOutcome: 'blocked_or_revised',
        prohibitedFilePatterns: ['test_image_validation.py', 'test', 'tests', 'spec'],
        expectedMentorResult: { expectedCapability: 'None' }
    },
    {
        id: 'mentor_arch_1',
        description: 'Positive Mentor Cases: Architecture',
        query: 'Explain the architecture',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'architecture_mentor',
            expectedRecommendationType: 'architecture'
        }
    },
    {
        id: 'mentor_onboard_1',
        description: 'Positive Mentor Cases: Onboarding',
        query: 'Where should I start?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'onboarding_mentor',
            expectedRecommendationType: 'onboarding'
        }
    },
    {
        id: 'mentor_change_1',
        description: 'Positive Mentor Cases: Change',
        query: 'What breaks if I modify X?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'change_mentor',
            expectedRecommendationType: 'change'
        }
    },
    {
        id: 'mentor_refactor_1',
        description: 'Positive Mentor Cases: Refactoring',
        query: 'What should I refactor first?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'refactoring_mentor',
            expectedRecommendationType: 'refactoring'
        }
    },
    {
        id: 'mentor_defect_1',
        description: 'Known Routing Regression Cases: Refactoring Defect 1',
        query: 'Which modules are risky?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'refactoring_mentor'
        }
    },
    {
        id: 'mentor_defect_2',
        description: 'Known Routing Regression Cases: Refactoring Defect 2',
        query: 'What architectural hotspots exist?',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'refactoring_mentor'
        }
    },
    {
        id: 'mentor_defect_3',
        description: 'Known Routing Regression Cases: Change Defect 1',
        query: 'Blast radius',
        expectedSpans: [],
        expectedFacts: [],
        prohibitedFilePatterns: [],
        expectedMentorResult: {
            expectedCapability: 'change_mentor'
        }
    }
];
