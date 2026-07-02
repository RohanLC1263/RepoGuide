import { EvidencePacket } from '../query/evidencePacket';
import { GateResult } from '../query/answerGate';
import { MentorExplanationContext } from './mentorTypes';
import { MentorEngine } from './mentorEngine';
import { ContextNormalizer } from '../query/contextNormalizer';
import { MentorContextAdapter } from './mentorContextAdapter';
import { queryTypeToCapability } from '../query/capabilityMapper';

export class MentorOrchestrator {
    private engine: MentorEngine;
    private normalizer: ContextNormalizer;
    private adapter: MentorContextAdapter;

    constructor() {
        this.engine = new MentorEngine();
        this.normalizer = new ContextNormalizer();
        this.adapter = new MentorContextAdapter();
    }

    public run(packet: EvidencePacket, gateResult: GateResult): MentorExplanationContext | null {
        // If the answer was blocked, we shouldn't attempt to append mentor advice
        if (gateResult.outcome === 'block') {
            return null;
        }

        const capability = queryTypeToCapability(packet.plan.queryType);
        if (capability === 'None') {
            return null;
        }

        // Normalize evidence into platform-wide ContextBundle
        const bundle = this.normalizer.normalize(packet, capability);
        
        // Adapt ContextBundle to Mentor-specific interface
        const context = this.adapter.adapt(bundle);
        
        // Return null if no meaningful evidence found to mentor on
        if (context.communityEvidence.length === 0 && 
            context.architecturalEvidence.length === 0 && 
            context.dependencyEvidence.length === 0 &&
            context.behavioralEvidence.length === 0) {
            return null;
        }

        // Run engine
        const explanationContext = this.engine.process(context);
        return explanationContext;
    }
}
