import * as crypto from 'crypto';
import { RelationshipDescriptor, RelationshipIdentity, RelationshipAggregate, IdentityDescriptor } from '../internalModels';
import { EvidenceReference } from '../../../semanticProviderContract';
import { CanonicalRelationshipSerializer } from '../../../canonicalRelationshipSerializer';

export class ObservationAccumulator {
    private aggregates = new Map<string, RelationshipAggregate>();

    public accumulate(descriptor: RelationshipDescriptor): void {
        const sourceHash = this.hashDescriptor(descriptor.source);
        const targetHash = this.hashDescriptor(descriptor.target);
        
        const identity: RelationshipIdentity = {
            sourceHash,
            targetHash,
            relationshipKind: descriptor.relationshipKind
        };

        const edgeId = this.hashIdentity(identity);

        let aggregate = this.aggregates.get(edgeId);
        if (!aggregate) {
            aggregate = {
                identity,
                source: descriptor.source,
                target: descriptor.target,
                evidence: []
            };
            this.aggregates.set(edgeId, aggregate);
        }

        // Create EvidenceReference
        const evidenceId = crypto.createHash('sha256')
            .update(edgeId)
            .update(descriptor.location.filePath)
            .update(descriptor.location.startLine.toString())
            .update(descriptor.location.endLine.toString())
            .digest('hex');

        // Check for duplicate evidence
        const isDuplicate = aggregate.evidence.some(e => e.id === evidenceId);
        if (!isDuplicate) {
            const evidence: EvidenceReference = {
                id: evidenceId,
                type: 'compiler',
                location: descriptor.location
            };
            aggregate.evidence.push(evidence);
        }
    }

    public getAggregates(): RelationshipAggregate[] {
        const result = Array.from(this.aggregates.values());
        
        // Deterministic Ordering of Edges
        result.sort((a, b) => this.hashIdentity(a.identity).localeCompare(this.hashIdentity(b.identity)));

        // Deterministic Ordering of Evidence
        for (const aggregate of result) {
            aggregate.evidence.sort((a, b) => {
                const fileCmp = (a.location?.filePath || '').localeCompare(b.location?.filePath || '');
                if (fileCmp !== 0) return fileCmp;
                const startCmp = (a.location?.startLine || 0) - (b.location?.startLine || 0);
                if (startCmp !== 0) return startCmp;
                return (a.location?.endLine || 0) - (b.location?.endLine || 0);
            });
        }

        return result;
    }

    private hashDescriptor(descriptor: IdentityDescriptor): string {
        return CanonicalRelationshipSerializer.hashIdentity(descriptor);
    }

    private hashIdentity(identity: RelationshipIdentity): string {
        return CanonicalRelationshipSerializer.hashRelationship(
            identity.relationshipKind, 
            identity.sourceHash, 
            identity.targetHash
        );
    }
}
