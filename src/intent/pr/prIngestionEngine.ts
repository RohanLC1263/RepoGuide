import { PullRequestStore } from './pullRequestStore';
import { PullRequestProvider } from './providers/pullRequestProvider';
import { PRSyncStats, PullRequestEntity } from './prTypes';

export class PRIngestionEngine {
    constructor(
        private store: PullRequestStore,
        private provider: PullRequestProvider
    ) {}

    /**
     * Incrementally synchronizes PR metadata from the provider into the local store.
     */
    public async syncIncremental(): Promise<PRSyncStats> {
        const stats: PRSyncStats = {
            prsProcessed: 0,
            commentsProcessed: 0,
            reviewsProcessed: 0,
            commitsProcessed: 0,
            startedAt: new Date(),
            completedAt: new Date()
        };

        try {
            const lastSync = this.store.getLastSyncTimestamp();
            const prs = await this.provider.listPullRequests(lastSync || undefined);

            // Process sequentially to avoid DB locking or rate limit blowouts, 
            // though batching could be used in full production
            for (const partialPr of prs) {
                // Fetch full enriched data
                const comments = await this.provider.getComments(partialPr.id);
                const reviews = await this.provider.getReviews(partialPr.id);
                const files = await this.provider.getChangedFiles(partialPr.id);
                const commits = await this.provider.getCommits(partialPr.id);

                // Construct full entity
                const fullPr: PullRequestEntity = {
                    ...partialPr,
                    comments,
                    reviews,
                    files,
                    commits
                };

                // Upsert to DB
                await this.store.save(fullPr);

                // Update stats
                stats.prsProcessed++;
                stats.commentsProcessed += comments.length;
                stats.reviewsProcessed += reviews.length;
                stats.commitsProcessed += commits.length;
            }

            // Mark completed
            stats.completedAt = new Date();
            this.store.setLastSyncTimestamp(stats.startedAt); // Set to start time to avoid missing PRs updated during sync

            return stats;

        } catch (error) {
            // Partial sync failures are tolerated because lastSyncTimestamp isn't updated
            // Next run will simply re-fetch the failed pages.
            stats.completedAt = new Date();
            throw new Error(`PRIngestionEngine sync failed: ${(error as Error).message}`);
        }
    }
}
