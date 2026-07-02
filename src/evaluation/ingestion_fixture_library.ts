import { IngestionFixture, IngestionExpectedOutcome } from "./memory_ingestion_golden_types";

export const FIXTURES: Array<{ fixture: IngestionFixture; expected: IngestionExpectedOutcome }> = [
    {
        fixture: {
            id: 'promo-1-user-immediate',
            description: 'User memories immediately promote',
            inputObservations: [
                { content: 'Always use tabs', source: 'user', scope: 'repository', confidence: 1.0 }
            ],
            initialLanceDbState: []
        },
        expected: {
            finalMemoryState: 'persistent',
            expectedMemoryCountDelta: 1,
            expectedTimelineEvents: ['promoted']
        }
    },
    {
        fixture: {
            id: 'promo-2-mentor-ephemeral',
            description: 'Mentor memories remain ephemeral (1 observation)',
            inputObservations: [
                { content: 'File uses async/await', source: 'mentor', scope: 'file', confidence: 0.8 }
            ],
            initialLanceDbState: []
        },
        expected: {
            finalMemoryState: 'ephemeral',
            expectedMemoryCountDelta: 0,
            expectedTimelineEvents: []
        }
    },
    {
        fixture: {
            id: 'promo-3-mentor-threshold',
            description: 'N-observation threshold promotion (3 observations)',
            inputObservations: [
                { content: 'Project uses React', source: 'mentor', scope: 'repository', confidence: 0.9 },
                { content: 'Project uses React', source: 'mentor', scope: 'repository', confidence: 0.9 },
                { content: 'Project uses React', source: 'mentor', scope: 'repository', confidence: 0.9 }
            ],
            initialLanceDbState: []
        },
        expected: {
            finalMemoryState: 'persistent',
            expectedMemoryCountDelta: 1,
            expectedTimelineEvents: ['promoted']
        }
    },
    {
        fixture: {
            id: 'valid-1-triviality',
            description: 'Triviality filter drops low-value observations',
            inputObservations: [
                { content: 'function add(a, b)', source: 'system', scope: 'file', confidence: 0.9 }
            ],
            initialLanceDbState: []
        },
        expected: {
            finalMemoryState: 'rejected',
            expectedMemoryCountDelta: 0,
            expectedTimelineEvents: []
        }
    },
    {
        fixture: {
            id: 'valid-2-schema',
            description: 'Schema bounds validation',
            inputObservations: [
                { content: 'Invalid confidence', source: 'system', scope: 'file', confidence: 1.5 }
            ],
            initialLanceDbState: []
        },
        expected: {
            finalMemoryState: 'rejected',
            expectedMemoryCountDelta: 0,
            expectedTimelineEvents: []
        }
    },
    {
        fixture: {
            id: 'dedup-1-merge',
            description: 'Duplicate memories merge scope rather than creating new vectors',
            inputObservations: [
                { content: 'The project uses Express.js', source: 'system', scope: 'module', confidence: 0.9 }
            ],
            initialLanceDbState: [
                {
                    id: 'existing-1',
                    repositoryId: 'repo-1',
                    content: 'Express.js is the framework used',
                    scope: 'module',
                    scopeKeys: ['backend'],
                    tags: [],
                    stale: false,
                    provenance: { authorType: 'system', timestamp: new Date().toISOString() }
                }
            ]
        },
        expected: {
            finalMemoryState: 'persistent',
            expectedMemoryCountDelta: 0,
            expectedTimelineEvents: ['merged']
        }
    },
    {
        fixture: {
            id: 'conflict-1-system-overrides-mentor',
            description: 'Newer system fact overrides older mentor fact',
            inputObservations: [
                { content: 'Uses Vitest for testing', source: 'system', scope: 'repository', confidence: 0.9 }
            ],
            initialLanceDbState: [
                {
                    id: 'existing-2',
                    repositoryId: 'repo-1',
                    content: 'Uses Jest for testing',
                    scope: 'repository',
                    scopeKeys: [],
                    tags: [],
                    stale: false,
                    provenance: { authorType: 'mentor', timestamp: new Date().toISOString() }
                }
            ]
        },
        expected: {
            finalMemoryState: 'persistent',
            expectedMemoryCountDelta: 0,
            expectedConflictWinner: 'new-id', // The new one wins, existing-2 should be staled
            expectedTimelineEvents: ['staled', 'promoted'] // 'created' will be implicitly added by runner
        }
    },
    {
        fixture: {
            id: 'conflict-2-ambiguous',
            description: 'Ambiguous mentor conflict escalates to human',
            inputObservations: [
                { content: 'Uses snake_case', source: 'mentor', scope: 'repository', confidence: 0.8 }
            ],
            initialLanceDbState: [
                {
                    id: 'existing-3',
                    repositoryId: 'repo-1',
                    content: 'Uses camelCase',
                    scope: 'repository',
                    scopeKeys: [],
                    tags: [],
                    stale: false,
                    provenance: { authorType: 'mentor', timestamp: new Date().toISOString() }
                }
            ]
        },
        expected: {
            finalMemoryState: 'ephemeral',
            expectedMemoryCountDelta: 0,
            expectedTimelineEvents: []
        }
    }
];
