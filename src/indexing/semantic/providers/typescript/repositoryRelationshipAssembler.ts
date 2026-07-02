import * as crypto from 'crypto';
import { RelationshipAggregate } from './internalModels';
import { RepositoryRelationship, RelationshipCategory, RelationshipKind } from '../../semanticProviderContract';
import { CanonicalIdentityFactory } from './resolution/canonicalIdentityFactory';
import { CanonicalRelationshipSerializer } from '../../canonicalRelationshipSerializer';

export class RepositoryRelationshipAssembler {
    public assemble(aggregate: RelationshipAggregate): RepositoryRelationship {
        const sourceIdentity = CanonicalIdentityFactory.create(aggregate.source);
        const targetIdentity = CanonicalIdentityFactory.create(aggregate.target);
        const category = this.deriveCategory(aggregate.identity.relationshipKind);

        // Compute immutable Relationship ID
        // hash(relationshipKind + hash(sourceCanonicalIdentity) + hash(targetCanonicalIdentity))
        // As defined in architecture: The hash uses canonical identity values, not strings.
        // Wait, CanonicalIdentity does not have a "hash" method. We will hash its stringified JSON.
        // Or we can just use the hashes that ObservationAccumulator computed which are essentially hashes of IdentityDescriptor.
        // The architecture says: "Construct RepositoryRelationship objects exclusively from language-neutral primitives."
        
        const id = CanonicalRelationshipSerializer.hashRelationship(
            aggregate.identity.relationshipKind,
            sourceIdentity,
            targetIdentity
        );

        return {
            id,
            category,
            relationshipKind: aggregate.identity.relationshipKind,
            source: sourceIdentity,
            target: targetIdentity,
            evidence: aggregate.evidence
        };
    }

    private deriveCategory(kind: RelationshipKind): RelationshipCategory {
        switch (kind) {
            case 'DECLARES':
            case 'IMPORTS':
            case 'EXTENDS':
            case 'IMPLEMENTS':
                return 'structural';
            case 'CALLS':
            case 'INSTANTIATES':
            case 'REFERENCES':
                return 'semantic';
            default:
                return 'semantic'; // fallback
        }
    }

}
