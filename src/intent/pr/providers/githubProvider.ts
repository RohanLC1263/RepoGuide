import { PullRequestProvider } from './pullRequestProvider';
import { PullRequestEntity, PullRequestComment, PullRequestReview, PullRequestFile, PullRequestCommit } from '../prTypes';

export class GitHubPullRequestProvider implements PullRequestProvider {
    
    constructor(private repoOwner: string, private repoName: string, private token?: string) {}

    public async listPullRequests(since?: Date): Promise<PullRequestEntity[]> {
        // V1 Stub: In a real implementation, this hits: GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=asc
        // If 'since' is provided, it handles pagination stopping when it hits older PRs.
        return [];
    }

    public async getPullRequest(id: string): Promise<PullRequestEntity> {
        throw new Error("Method not implemented.");
    }

    public async getComments(id: string): Promise<PullRequestComment[]> {
        // V1 Stub: Hits GET /repos/{owner}/{repo}/issues/{pull_number}/comments and GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
        return [];
    }

    public async getReviews(id: string): Promise<PullRequestReview[]> {
        // V1 Stub: Hits GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
        return [];
    }

    public async getChangedFiles(id: string): Promise<PullRequestFile[]> {
        // V1 Stub: Hits GET /repos/{owner}/{repo}/pulls/{pull_number}/files
        return [];
    }

    public async getCommits(id: string): Promise<PullRequestCommit[]> {
        // V1 Stub: Hits GET /repos/{owner}/{repo}/pulls/{pull_number}/commits
        return [];
    }
}
