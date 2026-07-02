import { ProgramHandle, ResolvedRelationshipObservation, RelationshipDescriptor } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';

export class RelationshipDescriptorBuilder {
    public static build(observation: ResolvedRelationshipObservation, handle: ProgramHandle): RelationshipDescriptor {
        const sourceDescriptor = IdentityDescriptorBuilder.build(observation.source, handle);
        const targetDescriptor = IdentityDescriptorBuilder.build(observation.target, handle);

        return {
            source: sourceDescriptor,
            target: targetDescriptor,
            relationshipKind: observation.relationshipKind,
            location: observation.location
        };
    }
}
