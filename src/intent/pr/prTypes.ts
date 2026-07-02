export interface PullRequestCommit {
    sha: string;
    message: string;
    author: string;
    timestamp: Date;
}

export interface PullRequestFile {
    path: string;
    additions: number;
    deletions: number;
    changes: number;
}

export interface PullRequestComment {
    id: string;
    author: string;
    body: string;
    createdAt: Date;
}

export interface PullRequestReview {
    id: string;
    reviewer: string;
    state: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED";
    submittedAt: Date;
}

export interface PullRequestEntity {
    id: string;
    number: number;
    title: string;
    body: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    author: string;
    createdAt: Date;
    updatedAt: Date;
    mergedAt?: Date;
    repositoryId: string;
    
    // Aggregated associated data
    commits: PullRequestCommit[];
    files: PullRequestFile[];
    comments: PullRequestComment[];
    reviews: PullRequestReview[];
}

export interface PRSyncStats {
    prsProcessed: number;
    commentsProcessed: number;
    reviewsProcessed: number;
    commitsProcessed: number;
    startedAt: Date;
    completedAt: Date;
}
