import { CommitEntity } from '../commitTypes';

export interface CommitProvider {
    /**
     * Lists commits. If `sinceSha` is provided, fetches commits from that SHA to HEAD.
     */
    listCommits(sinceSha?: string): Promise<CommitEntity[]>;
    
    /**
     * Verifies if a given SHA exists in the current git history.
     */
    verifyCheckpointExists(sha: string): Promise<boolean>;
}
