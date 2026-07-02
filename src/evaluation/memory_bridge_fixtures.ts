export interface MemoryBridgeFixture {
    id: string;
    scenario: string;
    query: string;
    mockMemories: Array<{
        content: string;
        scope: string;
        tags: string[];
        stale: boolean;
        author: string;
    }>;
    expectedBehavior: string;
}

export const memoryBridgeFixtures: MemoryBridgeFixture[] = [
    {
        id: "MB_001",
        scenario: "Why questions",
        query: "Why did we use LanceDB instead of SQLite?",
        mockMemories: [
            {
                content: "We migrated to LanceDB for vector similarity search capabilities because SQLite FTS5 wasn't sufficient for semantic queries.",
                scope: "Architecture",
                tags: ["database", "rationale"],
                stale: false,
                author: "system"
            }
        ],
        expectedBehavior: "Prompt should include the Memory Context section with the rationale for LanceDB over SQLite."
    },
    {
        id: "MB_002",
        scenario: "Historical decisions",
        query: "What was the reason for removing the abstract planner layer?",
        mockMemories: [
            {
                content: "The abstract planner layer caused too much latency and was difficult to debug. We flattened it into direct EvidencePacketBuilder calls.",
                scope: "History",
                tags: ["planner", "latency"],
                stale: false,
                author: "tech-lead"
            }
        ],
        expectedBehavior: "Prompt should include historical context explaining the latency and debuggability issues."
    },
    {
        id: "MB_003",
        scenario: "Architecture rationale",
        query: "Why is ContextNormalizer separate from EvidenceAnswerSynthesizer?",
        mockMemories: [
            {
                content: "ContextNormalizer is dedicated to producing structured ContextBundle objects for the Mentor orchestration, whereas the Synthesizer builds the raw text prompt for primary generation.",
                scope: "Architecture",
                tags: ["mentor", "synthesizer", "architecture"],
                stale: false,
                author: "architect"
            }
        ],
        expectedBehavior: "Prompt should inject the architectural boundary clarification."
    },
    {
        id: "MB_004",
        scenario: "Developer guidance",
        query: "How should I handle token counting?",
        mockMemories: [
            {
                content: "For telemetry, we use a simple Math.ceil(text.length / 4) heuristic to avoid loading heavy tokenizer models unnecessarily.",
                scope: "Guidance",
                tags: ["telemetry", "tokens", "performance"],
                stale: false,
                author: "system"
            }
        ],
        expectedBehavior: "Prompt should include guidance on using the lightweight heuristic."
    },
    {
        id: "MB_005",
        scenario: "No memory match",
        query: "What is the capital of France?",
        mockMemories: [],
        expectedBehavior: "Prompt should NOT contain a MEMORY CONTEXT section."
    },
    {
        id: "MB_006",
        scenario: "Multiple memory match",
        query: "Explain the retrieval system.",
        mockMemories: [
            {
                content: "Retrieval uses LanceDB for semantic vector search.",
                scope: "Architecture",
                tags: ["retrieval"],
                stale: false,
                author: "system"
            },
            {
                content: "LifecycleAwareRetriever wraps the base retriever to filter out dormant memory records.",
                scope: "Architecture",
                tags: ["retrieval", "lifecycle"],
                stale: false,
                author: "system"
            }
        ],
        expectedBehavior: "Prompt should include both memories under MEMORY CONTEXT."
    },
    {
        id: "MB_007",
        scenario: "Conflicting memories",
        query: "Are we using SQLite?",
        mockMemories: [
            {
                content: "We use SQLite for all local memory storage.",
                scope: "Architecture",
                tags: ["storage"],
                stale: true, // This is key
                author: "v1-author"
            },
            {
                content: "We replaced SQLite with LanceDB for memory storage.",
                scope: "Architecture",
                tags: ["storage", "lancedb"],
                stale: false,
                author: "v2-author"
            }
        ],
        expectedBehavior: "Prompt should include both, but strictly label the SQLite memory as STALE."
    }
];
