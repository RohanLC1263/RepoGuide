import { createHash } from 'crypto';
import { IntentStore } from './intentStore';
import { IntentNormalizer, IntentCandidate } from './intentNormalizer';
import { IntentEntity, IntentEvidence, IntentType } from './intentTypes';
import { CommitStore } from '../commit/commitStore';
import { PullRequestStore } from '../pr/pullRequestStore';
import { ADRQueryEngine } from '../adr/adrQueryEngine';
import { ADREntity } from '../adr/adrTypes';
import { PullRequestEntity } from '../pr/prTypes';
import { CommitEntity } from '../commit/commitTypes';

export interface GraphBuilderInterface {
    build(): void;
}

export class IntentExtractionEngine {
    constructor(
        private intentStore: IntentStore,
        private normalizer: IntentNormalizer,
        private commitStore: CommitStore,
        private prStore: PullRequestStore,
        private adrEngine: ADRQueryEngine,
        private graphBuilder?: GraphBuilderInterface
    ) {}

    private generateIntentId(type: IntentType, canonicalTopic: string): string {
        return createHash('sha256').update(`${type}:${canonicalTopic}`).digest('hex');
    }

    private getBaseConfidence(sourceType: "ADR" | "PR" | "COMMIT"): number {
        if (sourceType === "ADR") return 1.0;
        if (sourceType === "PR") return 0.8;
        return 0.6; // COMMIT
    }

    public async extractIncremental(limit: number = 1000): Promise<number> {
        let itemsProcessed = 0;
        
        // Accumulate intents and evidence before writing to DB
        const batchIntents = new Map<string, IntentEntity>();
        const batchEvidence: IntentEvidence[] = [];

        const processSource = (
            text: string, 
            sourceType: "ADR" | "PR" | "COMMIT", 
            sourceId: string, 
            date: Date
        ) => {
            const candidates = this.normalizer.extractAndNormalize(text);
            const sourceConfidence = this.getBaseConfidence(sourceType);

            for (const candidate of candidates) {
                const id = this.generateIntentId(candidate.type, candidate.canonicalTopic);
                
                // Track Evidence
                batchEvidence.push({
                    intentId: id,
                    sourceType,
                    sourceId,
                    snippet: candidate.matchedText,
                    createdAt: date
                });

                // Update Intent Accumulator
                if (batchIntents.has(id)) {
                    const existing = batchIntents.get(id)!;
                    existing.evidenceCount += 1;
                    existing.confidence = Math.max(existing.confidence, sourceConfidence);
                    if (sourceType === "ADR") existing.adrCount += 1;
                    if (sourceType === "PR") existing.prCount += 1;
                    if (sourceType === "COMMIT") existing.commitCount += 1;
                    if (date < existing.firstSeenAt) existing.firstSeenAt = date;
                    if (date > existing.lastSeenAt) existing.lastSeenAt = date;
                } else {
                    batchIntents.set(id, {
                        id,
                        type: candidate.type,
                        canonicalTopic: candidate.canonicalTopic,
                        confidence: sourceConfidence,
                        evidenceCount: 1,
                        adrCount: sourceType === "ADR" ? 1 : 0,
                        prCount: sourceType === "PR" ? 1 : 0,
                        commitCount: sourceType === "COMMIT" ? 1 : 0,
                        firstSeenAt: date,
                        lastSeenAt: date
                    });
                }
            }
        };

        // 1. Process Commits
        const lastCommitTimeStr = this.intentStore.getSyncState('last_commit_timestamp');
        const lastCommitTime = lastCommitTimeStr ? new Date(lastCommitTimeStr) : null;
        const commits = this.commitStore.getCommitsSince(lastCommitTime, limit);
        
        for (const commit of commits) {
            processSource(commit.message, "COMMIT", commit.sha, commit.timestamp);
            itemsProcessed++;
        }

        // 2. Process PRs
        const lastPrTimeStr = this.intentStore.getSyncState('last_pr_timestamp');
        const lastPrTime = lastPrTimeStr ? new Date(lastPrTimeStr) : null;
        const prs = this.prStore.getPRsSince(lastPrTime, limit);
        
        for (const pr of prs) {
            const fullText = `${pr.title}\n\n${pr.body}`;
            processSource(fullText, "PR", pr.id, pr.updatedAt);
            itemsProcessed++;
        }

        // 3. Process ADRs (We re-process all ADRs because they are small, but evidence idempotent insertion protects us)
        // Ideally we'd also track ADR sync state, but for V1 we do full pass.
        const adrs = await this.adrEngine.listADRs();
        for (const adr of adrs) {
            const fullText = `${adr.title}\n${adr.context}\n${adr.decision}\n${adr.consequences}`;
            // Use fallback date if not provided in ADR entity
            const adrDate = adr.updatedAt || adr.createdAt || new Date();
            processSource(fullText, "ADR", adr.id, adrDate);
            itemsProcessed++;
        }

        // Write batch
        if (batchIntents.size > 0 || batchEvidence.length > 0) {
            await this.intentStore.saveBatch(batchIntents, batchEvidence);
        }

        // Update Sync State
        if (commits.length > 0) {
            const maxCommitDate = commits[commits.length - 1].timestamp;
            this.intentStore.setSyncState('last_commit_timestamp', maxCommitDate.toISOString());
        }
        if (prs.length > 0) {
            const maxPrDate = prs[prs.length - 1].updatedAt;
            this.intentStore.setSyncState('last_pr_timestamp', maxPrDate.toISOString());
        }

        // Trigger Graph Rebuild
        if (this.graphBuilder && (batchIntents.size > 0 || batchEvidence.length > 0)) {
            this.graphBuilder.build();
        }

        return itemsProcessed;
    }
}
