import { MemoryProposal } from "./memoryProposal";
import { createCandidate } from "./candidateMemory";
import { IngestionResult } from "./ingestionResult";
import { ValidationPipeline } from "./validationPipeline";
import { DeduplicationService } from "./deduplicationService";
import { ConflictResolutionService } from "./conflictResolutionService";
import { PromotionService } from "./promotionService";
import { MemoryStore } from "../memoryTypes";
import { TimelineEventEmitter } from "../lifecycle/timelineEventEmitter";

export class MemoryIngestionPipeline {
    constructor(
        private readonly memoryStore: MemoryStore,
        private readonly validation: ValidationPipeline,
        private readonly deduplication: DeduplicationService,
        private readonly conflictResolution: ConflictResolutionService,
        private readonly promotion: PromotionService,
        private readonly timelineEmitter: TimelineEventEmitter
    ) {}

    public async ingest(proposal: MemoryProposal): Promise<IngestionResult> {
        const candidate = createCandidate(proposal);

        // 1. Validation Gate
        const validationResult = this.validation.validate(candidate);
        if (!validationResult.passed) {
            return {
                accepted: false,
                rejectionReason: validationResult.reason,
                finalState: 'rejected'
            };
        }

        // 2. Deduplication Gate
        const dedupResult = await this.deduplication.deduplicate(candidate);
        if (dedupResult.isDuplicate) {
            await this.timelineEmitter.memoryMerged(dedupResult.mergedMemoryId!, candidate.candidateId);
            return {
                accepted: true,
                finalState: 'persistent', // Merged into existing persistent memory
                affectedMemoryId: dedupResult.mergedMemoryId
            };
        }

        // 3. Conflict Resolution Gate
        const conflictResult = await this.conflictResolution.detectAndResolve(candidate);
        if (conflictResult.loserMemoryId) {
            await this.timelineEmitter.memoryStaled(conflictResult.loserMemoryId, `Staled by candidate ${candidate.candidateId}`);
        }
        
        if (conflictResult.escalateToHuman) {
            return {
                accepted: true,
                finalState: 'ephemeral',
                rejectionReason: 'Human escalation required for conflict resolution.'
            };
        }

        // 4. Promotion Gate
        const promotionResult = await this.promotion.evaluate(candidate);
        if (promotionResult.promote) {
            const newRecord = await this.memoryStore.create({
                externalId: candidate.proposal.externalId,
                repositoryId: candidate.proposal.repositoryId,
                content: candidate.proposal.content,
                scope: candidate.proposal.scope,
                scopeKeys: candidate.proposal.scopeKeys,
                tags: candidate.proposal.tags,
                stale: candidate.proposal.stale ?? false,
                provenance: {
                    authorType: candidate.proposal.source,
                    timestamp: candidate.timestamp
                }
            });

            await this.timelineEmitter.memoryCreated(newRecord.id, `Candidate ${candidate.candidateId} created`);
            await this.timelineEmitter.memoryPromoted(newRecord.id, `Candidate ${candidate.candidateId} promoted to persistent`);

            return {
                accepted: true,
                finalState: 'persistent',
                affectedMemoryId: newRecord.id
            };
        } else {
            return {
                accepted: true,
                finalState: 'ephemeral'
            };
        }
    }
}
