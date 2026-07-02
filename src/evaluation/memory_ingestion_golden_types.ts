/**
 * memory_ingestion_golden_types.ts
 * 
 * Defines the contract for Memory Ingestion Evaluation.
 * This establishes what success and failure look like before ingestion is implemented.
 */

import { MemoryRecord } from "../memory/memoryTypes";

export interface IngestionFixture {
    id: string;
    description: string;
    inputObservations: Array<{
        content: string;
        source: 'user' | 'mentor' | 'system' | 'mcp';
        scope: 'repository' | 'module' | 'file';
        confidence: number;
    }>;
    initialLanceDbState: MemoryRecord[];
}

export interface IngestionGateResults {
    passedValidation: boolean;
    passedDeduplication: boolean;
    passedConflictResolution: boolean;
    passedPromotion: boolean;
    rejectionReason?: string;
}

export interface IngestionExpectedOutcome {
    finalMemoryState: 'rejected' | 'ephemeral' | 'persistent' | 'dormant' | 'stale';
    expectedMemoryCountDelta: number; // e.g., 0 for dedup, +1 for new, -1 for budget prune
    expectedProvenanceCount?: number; // How many sources confirm this memory?
    expectedConflictWinner?: string;  // If conflict occurs, which memory ID survives?
    expectedTimelineEvents: Array<'created' | 'promoted' | 'merged' | 'staled' | 'dormant' | 'archived'>;
}

export interface IngestionEvalReport {
    fixtureId: string;
    passed: boolean;
    gates: IngestionGateResults;
    actualOutcome: {
        finalMemoryState: string;
        memoryCountDelta: number;
        provenanceCount: number;
        timelineEvents: string[];
    };
    discrepancyMessage?: string;
}
