import { MemoryRecord } from '../memory/memoryTypes';

export const benchmarkCorpus: Omit<MemoryRecord, 'id' | 'repositoryId'>[] = [
    {
        content: 'RepoGuide is designed with a local-first architecture to ensure privacy, zero latency, and seamless offline capability. All data, including LanceDB, operates entirely on the local machine.',
        scope: 'architecture',
        scopeKeys: [],
        tags: ['architecture', 'local-first', 'privacy'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'LanceDB was selected over PostgreSQL and SQLite for our MemoryStore due to its native integration with vector search and its ability to run embedded locally without requiring background daemon management.',
        scope: 'architecture',
        scopeKeys: [],
        tags: ['architecture', 'database', 'lancedb', 'vector-search'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'The Mentor system exists to provide specialized, domain-specific guidance (e.g., Security Mentor, Performance Mentor) rather than relying on a monolithic generalist prompt.',
        scope: 'product',
        scopeKeys: [],
        tags: ['product', 'mentor-system', 'modular-ai'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'BM25 was introduced alongside vector embeddings to form a hybrid search approach. Vector search alone struggled with exact keyword matches.',
        scope: 'technical',
        scopeKeys: [],
        tags: ['technical', 'search', 'bm25', 'hybrid-search'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    },
    {
        content: 'The Evidence Pipeline replaced legacy retrieval because the legacy system was a rigid, single-pass fetcher. The Evidence Pipeline allows for multi-stage, iterative retrieval.',
        scope: 'technical',
        scopeKeys: [],
        tags: ['technical', 'evidence-pipeline', 'retrieval'],
        stale: false,
        provenance: { authorType: 'System', timestamp: new Date().toISOString() }
    }
    // Note: To keep the script self-contained and runnable, 5 golden memories are used as the representative base for the 5 queries.
];

export interface BenchmarkQuery {
    id: string;
    text: string;
    expectedTag: string;
}

export const benchmarkQueries: BenchmarkQuery[] = [
    { id: 'Q1', text: 'Why is RepoGuide local-first?', expectedTag: 'local-first' },
    { id: 'Q2', text: 'Why do we use LanceDB database?', expectedTag: 'lancedb' },
    { id: 'Q3', text: 'What is the purpose of the Mentor system?', expectedTag: 'mentor-system' },
    { id: 'Q4', text: 'Why was BM25 added to the search?', expectedTag: 'bm25' },
    { id: 'Q5', text: 'Why did we build the Evidence Pipeline?', expectedTag: 'evidence-pipeline' }
];
