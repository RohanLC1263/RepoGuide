import { GateResult } from './answerGate';
import { EvidencePacket } from './evidencePacket';
import { ExecutionPlan } from './executionPlanner';
import { RetrievalOrchestrationResult } from './retrievalOrchestrator';

export interface EvidenceQueryTelemetrySnapshot {
    mode: 'evidence';
    question: string;
    executionPlan?: ExecutionPlan;
    retrievalResult?: RetrievalOrchestrationResult;
    packet?: EvidencePacket;
    synthesizedAnswer?: string;
    answerGate?: GateResult;
    /** Present only when the query ran decomposed (multi-facet questions). */
    decomposition?: {
        subQuestions: string[];
        subOutcomes: Array<{ question: string; gateOutcome: GateResult['outcome']; elapsedMs: number }>;
        mergeUsedFallback: boolean;
        finalGateOutcome?: GateResult['outcome'];
    };
    timings: {
        planningMs?: number;
        retrievalMs?: number;
        packetMs?: number;
        synthesisMs?: number;
        answerGateMs?: number;
        totalMs?: number;
    };
}

export type EvidenceQueryTelemetrySink = (snapshot: EvidenceQueryTelemetrySnapshot) => void;
