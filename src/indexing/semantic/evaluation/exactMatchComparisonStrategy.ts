import { ComparisonStrategy, ComparisonResult } from './comparisonStrategy';
import { GroundTruth, EvaluationCandidate, EvaluationFinding, CapabilityEvaluation } from './evaluationModels';
import { REGISTRY_CAPABILITIES, CapabilityDefinition } from './capabilities';
import { RepositoryEntity, RepositoryRelationship, KnownUnknown } from '../semanticProviderContract';

function generateId(): string {
    return Math.random().toString(36).substring(2, 9);
}

export class ExactMatchComparisonStrategy implements ComparisonStrategy {
    public readonly name = 'ExactMatchComparisonStrategy';

    public compare(candidate: EvaluationCandidate, truth: GroundTruth): ComparisonResult {
        let globalTruePositives = 0;
        let globalFalsePositives = 0;
        let globalFalseNegatives = 0;
        const findings: EvaluationFinding[] = [];
        const capabilityMap = new Map<string, { tp: number; fp: number; fn: number }>();

        // Initialize capabilities
        for (const cap of REGISTRY_CAPABILITIES) {
            capabilityMap.set(cap.id, { tp: 0, fp: 0, fn: 0 });
        }

        const candidateEntities = candidate.result.entities;
        const candidateRelationships = candidate.result.relationships;
        const candidateUnknowns = candidate.result.knownUnknowns;

        // Create sets for fast lookup of urns
        const truthEntityUrns = new Set(truth.expectedEntities.map(e => `${e.canonicalId.package}:${e.canonicalId.qualifiedName}:${e.canonicalId.signatureHash}`));
        const truthRelKeys = new Set(truth.expectedRelationships.map(r => `${r.source.package}:${r.source.qualifiedName}->${r.target.package}:${r.target.qualifiedName}:${r.relationshipKind}`));
        const truthUnknownsKeys = new Set(truth.expectedUnknowns.map(u => `${u.sourceLocation.filePath}:${u.sourceLocation.startLine}-${u.sourceLocation.endLine}:${u.unsupportedConstruct}`));
        
        const candidateEntityUrns = new Set(candidateEntities.map(e => `${e.canonicalId.package}:${e.canonicalId.qualifiedName}:${e.canonicalId.signatureHash}`));
        const candidateRelKeys = new Set(candidateRelationships.map(r => `${r.source.package}:${r.source.qualifiedName}->${r.target.package}:${r.target.qualifiedName}:${r.relationshipKind}`));
        const candidateUnknownsKeys = new Set(candidateUnknowns.map(u => `${u.sourceLocation.filePath}:${u.sourceLocation.startLine}-${u.sourceLocation.endLine}:${u.unsupportedConstruct}`));

        // Helper to evaluate an item against capabilities
        const evaluateCapabilities = (
            item: RepositoryEntity | RepositoryRelationship | KnownUnknown,
            isTP: boolean,
            isFP: boolean,
            isFN: boolean
        ) => {
            for (const cap of REGISTRY_CAPABILITIES) {
                if (this.itemMatchesCapability(item, cap)) {
                    const stats = capabilityMap.get(cap.id)!;
                    if (isTP) stats.tp++;
                    if (isFP) stats.fp++;
                    if (isFN) stats.fn++;
                }
            }
        };

        // Entities
        for (const e of truth.expectedEntities) {
            const eUrn = `${e.canonicalId.package}:${e.canonicalId.qualifiedName}:${e.canonicalId.signatureHash}`;
            if (candidateEntityUrns.has(eUrn)) {
                globalTruePositives++;
                evaluateCapabilities(e, true, false, false);
            } else {
                globalFalseNegatives++;
                evaluateCapabilities(e, false, false, true);
                findings.push({
                    id: generateId(),
                    severity: 'critical',
                    category: 'Extraction Error',
                    recommendation: `Missed expected entity: ${eUrn}`
                });
            }
        }
        for (const e of candidateEntities) {
            const eUrn = `${e.canonicalId.package}:${e.canonicalId.qualifiedName}:${e.canonicalId.signatureHash}`;
            if (!truthEntityUrns.has(eUrn)) {
                globalFalsePositives++;
                evaluateCapabilities(e, false, true, false);
                findings.push({
                    id: generateId(),
                    severity: 'warning',
                    category: 'Extraction Error',
                    recommendation: `Extracted unexpected entity: ${eUrn}`
                });
            }
        }

        // Relationships
        for (const r of truth.expectedRelationships) {
            const key = `${r.source.package}:${r.source.qualifiedName}->${r.target.package}:${r.target.qualifiedName}:${r.relationshipKind}`;
            if (candidateRelKeys.has(key)) {
                globalTruePositives++;
                evaluateCapabilities(r, true, false, false);
            } else {
                globalFalseNegatives++;
                evaluateCapabilities(r, false, false, true);
                findings.push({
                    id: generateId(),
                    severity: 'critical',
                    category: 'Relationship Error',
                    recommendation: `Missed expected relationship: ${key}`
                });
            }
        }
        for (const r of candidateRelationships) {
            const key = `${r.source.package}:${r.source.qualifiedName}->${r.target.package}:${r.target.qualifiedName}:${r.relationshipKind}`;
            if (!truthRelKeys.has(key)) {
                globalFalsePositives++;
                evaluateCapabilities(r, false, true, false);
                findings.push({
                    id: generateId(),
                    severity: 'warning',
                    category: 'Relationship Error',
                    recommendation: `Extracted unexpected relationship: ${key}`
                });
            }
        }

        // Known Unknowns
        for (const u of truth.expectedUnknowns) {
            const key = `${u.sourceLocation.filePath}:${u.sourceLocation.startLine}-${u.sourceLocation.endLine}:${u.unsupportedConstruct}`;
            if (candidateUnknownsKeys.has(key)) {
                globalTruePositives++;
                evaluateCapabilities(u, true, false, false);
            } else {
                globalFalseNegatives++;
                evaluateCapabilities(u, false, false, true);
                findings.push({
                    id: generateId(),
                    severity: 'critical',
                    category: 'Calibration Error',
                    recommendation: `Missed expected unknown construct: ${key}`
                });
            }
        }
        for (const u of candidateUnknowns) {
            const key = `${u.sourceLocation.filePath}:${u.sourceLocation.startLine}-${u.sourceLocation.endLine}:${u.unsupportedConstruct}`;
            if (!truthUnknownsKeys.has(key)) {
                globalFalsePositives++;
                evaluateCapabilities(u, false, true, false);
                findings.push({
                    id: generateId(),
                    severity: 'warning',
                    category: 'Calibration Error',
                    recommendation: `Extracted unexpected unknown construct: ${key}`
                });
            }
        }

        const capabilityEvaluations: CapabilityEvaluation[] = [];
        for (const [id, stats] of capabilityMap.entries()) {
            const precision = (stats.tp + stats.fp) === 0 ? 1 : stats.tp / (stats.tp + stats.fp);
            const recall = (stats.tp + stats.fn) === 0 ? 1 : stats.tp / (stats.tp + stats.fn);
            capabilityEvaluations.push({
                capabilityId: id,
                truePositives: stats.tp,
                falsePositives: stats.fp,
                falseNegatives: stats.fn,
                precision,
                recall
            });
        }

        return {
            truePositives: globalTruePositives,
            falsePositives: globalFalsePositives,
            falseNegatives: globalFalseNegatives,
            findings,
            capabilityEvaluations
        };
    }

    private itemMatchesCapability(item: RepositoryEntity | RepositoryRelationship | KnownUnknown, cap: CapabilityDefinition): boolean {
        if (cap.customRule && cap.customRule(item)) {
            return true;
        }

        if ('entityKind' in item) { // Entity
            if (cap.supportedEntityKinds && cap.supportedEntityKinds.includes(item.entityKind)) {
                return true;
            }
        } else if ('relationshipKind' in item) { // Relationship
            if (cap.supportedRelationshipKinds && cap.supportedRelationshipKinds.includes(item.relationshipKind)) {
                return true;
            }
        }
        return false;
    }
}
