import { EvidencePacket } from '../query/evidencePacket';
import { GateResult } from '../query/answerGate';
import { MentorExplanationContext } from './mentorTypes';
import { MentorEngine } from './mentorEngine';
import { ContextNormalizer } from '../query/contextNormalizer';
import { MentorContextAdapter } from './mentorContextAdapter';
import { queryTypeToCapability } from '../query/capabilityMapper';
import { classifyQueryType } from '../query/evidencePlanner';

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

        // Appendix mis-attribution guard. packet.plan.queryType can come from the LLM
        // planner (used for "complex" queries), which mislabels "explain X ... and how it
        // affects Y" as impact_analysis/architecture_analysis -- attaching an irrelevant
        // Change-Impact / Architecture-Insights appendix to what is really an explanation.
        // The deterministic classifier lands those on behavior_explanation (-> 'None'). When
        // the two disagree THIS way -- LLM wants an appendix but the deterministic classifier
        // says this is a plain explanation/lookup -- trust the deterministic result and skip
        // the appendix. This never suppresses a genuine impact/architecture question: for
        // e.g. "what depends on X" the deterministic classifier ALSO returns impact_analysis
        // (non-'None'), so the guard doesn't fire. Scope is intentionally narrow: it only
        // gates appendix rendering here, it does NOT overwrite packet.plan.queryType (which
        // still drives retrieval/evidence selection upstream).
        const deterministicCapability = queryTypeToCapability(classifyQueryType(packet.query));
        if (deterministicCapability === 'None') {
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
