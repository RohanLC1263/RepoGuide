export type ChangeType = "A" | "M" | "D" | "R" | "C" | "U"; // Add, Modify, Delete, Rename, Copy, Unknown

export interface CommitFileChange {
    sha: string;
    path: string;
    oldPath?: string; // Populated only for Rename (R) and Copy (C)
    additions: number;
    deletions: number;
    changes: number;
    changeType: ChangeType;
}

export interface CommitEntity {
    sha: string;
    authorName: string;
    authorEmail: string;
    message: string;
    timestamp: Date;
    parentShas: string[];
    repositoryId: string;
    files: CommitFileChange[];
}

export interface CommitReference {
    sha: string;
    shortSha: string;
    message: string;
    timestamp: Date;
}

export interface CommitSyncStats {
    commitsProcessed: number;
    filesProcessed: number;
    durationMs: number;
    newestCommit?: string;
    oldestCommit?: string;
}
