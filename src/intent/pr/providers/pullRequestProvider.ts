import { PullRequestEntity, PullRequestComment, PullRequestReview, PullRequestFile, PullRequestCommit } from '../prTypes';

export interface PullRequestProvider {
    listPullRequests(since?: Date): Promise<PullRequestEntity[]>;
    getPullRequest(id: string): Promise<PullRequestEntity>;
    getComments(id: string): Promise<PullRequestComment[]>;
    getReviews(id: string): Promise<PullRequestReview[]>;
    getChangedFiles(id: string): Promise<PullRequestFile[]>;
    getCommits(id: string): Promise<PullRequestCommit[]>;
}
