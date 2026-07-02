import { ContextBundle } from '../query/contextNormalizer';
import { MentorContext } from './mentorTypes';

export class MentorContextAdapter {
    public adapt(bundle: ContextBundle): MentorContext {
        // We concatenate behavioralEvidence and generalContext for Mentor's logicalUnits bucket
        const behavioral = bundle.behavioralEvidence || [];
        const general = bundle.generalContext || [];

        return {
            capability: bundle.targetCapability as any,
            architecturalEvidence: bundle.architecturalEvidence,
            communityEvidence: bundle.communityEvidence,
            dependencyEvidence: bundle.dependencyEvidence,
            behavioralEvidence: [...behavioral, ...general],
            memoryEvidence: bundle.memoryEvidence || [],
            coverageScore: 1.0, // Can be pulled from packet if needed later
            confidenceMode: 'grounded'
        };
    }
}
