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
