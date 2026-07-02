import { SemanticExtractionResult, RepositoryEntity, RepositoryRelationship, KnownUnknown, EvidenceReference } from './semanticProviderContract';
import { CanonicalFact, FactObservation, CanonicalFactFactory } from './canonicalFact';

export interface CanonicalFactAdapterResult {
    facts: CanonicalFact[];
    observations: FactObservation[];
}

export class CanonicalFactAdapter {
    public static translate(result: SemanticExtractionResult): CanonicalFactAdapterResult {
        const factsMap = new Map<string, CanonicalFact>();
        const observations: FactObservation[] = [];
        
        const provenance = String(result.providerMetadata.providerName) + '@' + String(result.providerMetadata.providerVersion);

        // Process Entities
        for (const entity of result.entities || []) {
            const payload = {
                canonicalId: this.extractIdentity(entity.canonicalId),
                name: String(entity.name),
                entityKind: String(entity.entityKind),
                modifiers: Array.isArray(entity.modifiers) ? entity.modifiers.map(m => String(m)) : [],
                visibility: String(entity.visibility),
                documentation: entity.documentation ? String(entity.documentation) : undefined
            };
            const fact = CanonicalFactFactory.createFact('ENTITY', payload);
            if (!factsMap.has(fact.factId)) {
                factsMap.set(fact.factId, fact);
            }
            
            const evidence: EvidenceReference[] = [{
                id: `decl-${payload.canonicalId?.qualifiedName}-${entity.declarationLocation?.startLine}`,
                type: result.providerMetadata.extractionMethod === 'compiler' ? 'compiler' : 'ast',
                location: this.extractLocation(entity.declarationLocation)
            }];
            observations.push(CanonicalFactFactory.createObservation(fact.factId, provenance, evidence));
        }

        // Process Relationships
        for (const rel of result.relationships || []) {
            const payload = {
                category: String(rel.category),
                relationshipKind: String(rel.relationshipKind),
                source: this.extractIdentity(rel.source),
                target: this.extractIdentity(rel.target)
            };
            const fact = CanonicalFactFactory.createFact('RELATIONSHIP', payload);
            if (!factsMap.has(fact.factId)) {
                factsMap.set(fact.factId, fact);
            }
            const evidence = Array.isArray(rel.evidence) ? rel.evidence.map(e => this.extractEvidence(e)) : [];
            observations.push(CanonicalFactFactory.createObservation(fact.factId, provenance, evidence));
        }

        // Process KnownUnknowns
        for (const unknown of result.knownUnknowns || []) {
            const payload = {
                source: this.extractIdentity(unknown.source),
                unsupportedConstruct: String(unknown.unsupportedConstruct),
                reason: String(unknown.reason),
                recommendedHandling: String(unknown.recommendedHandling)
            };
            const fact = CanonicalFactFactory.createFact('UNKNOWN', payload);
            if (!factsMap.has(fact.factId)) {
                factsMap.set(fact.factId, fact);
            }
            
            let evidence = Array.isArray(unknown.evidence) ? unknown.evidence.map(e => this.extractEvidence(e)) : [];
            if (evidence.length === 0 && unknown.sourceLocation) {
                evidence = [{
                    id: `unk-${unknown.id}`,
                    type: 'compiler',
                    location: this.extractLocation(unknown.sourceLocation)
                }];
            }
            
            observations.push(CanonicalFactFactory.createObservation(fact.factId, provenance, evidence));
        }

        const facts = Array.from(factsMap.values()).sort((a, b) => a.factId.localeCompare(b.factId));
        observations.sort((a, b) => a.observationId.localeCompare(b.observationId));

        return { facts, observations };
    }

    private static extractIdentity(identity: any): any {
        if (!identity) return identity;
        return {
            kind: identity.kind ? String(identity.kind) : undefined,
            package: identity.package ? String(identity.package) : undefined,
            logicalNamespace: identity.logicalNamespace ? String(identity.logicalNamespace) : undefined,
            qualifiedName: identity.qualifiedName ? String(identity.qualifiedName) : undefined,
            signatureHash: identity.signatureHash ? String(identity.signatureHash) : undefined,
            identityOrigin: identity.identityOrigin ? String(identity.identityOrigin) : undefined,
            identityAuthority: identity.identityAuthority ? String(identity.identityAuthority) : undefined
        };
    }

    private static extractLocation(loc: any): any {
        if (!loc) return loc;
        return {
            filePath: loc.filePath ? String(loc.filePath) : undefined,
            startLine: typeof loc.startLine === 'number' ? loc.startLine : undefined,
            endLine: typeof loc.endLine === 'number' ? loc.endLine : undefined
        };
    }

    private static extractEvidence(evidence: any): any {
        if (!evidence) return evidence;
        return {
            id: evidence.id ? String(evidence.id) : undefined,
            type: evidence.type ? String(evidence.type) : undefined,
            location: this.extractLocation(evidence.location)
        };
    }
}
