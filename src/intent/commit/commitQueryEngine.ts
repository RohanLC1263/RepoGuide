import { CommitStore } from './commitStore';
import { CommitEntity } from './commitTypes';
import { ProgramGraphStore } from '../../store/programGraphStore';

export class CommitQueryEngine {
    constructor(
        private commitStore: CommitStore,
        private graphStore: ProgramGraphStore
    ) {}

    /**
     * Retrieve a specific commit by its SHA.
     */
    public getCommit(sha: string): CommitEntity | null {
        return this.commitStore.getBySha(sha);
    }

    /**
     * Retrieve all commits that modified a specific file path (including via renames).
     */
    public getCommitsForFile(path: string): CommitEntity[] {
        return this.commitStore.getByFile(path);
    }

    /**
     * Retrieve recent commits up to a limit.
     */
    public getRecentCommits(limit: number): CommitEntity[] {
        return this.commitStore.getRecentCommits(limit);
    }

    /**
     * Retrieve all commits by a specific author.
     */
    public getCommitsByAuthor(author: string): CommitEntity[] {
        return this.commitStore.getByAuthor(author);
    }

    /**
     * Mandatory V1 Bridge API: Connects the structural Graph Layer with the Commit History Layer.
     * Resolves a symbol (or AST node ID) to its physical file, then looks up its full commit history.
     */
    public getCommitsForNode(symbolOrId: string): CommitEntity[] {
        // First resolve to a node in the graph
        let node = this.graphStore.getNode(symbolOrId);
        
        // If not found directly by ID, attempt to resolve by symbol
        if (!node) {
            const resolvedIds = this.graphStore.getNodesBySymbol(symbolOrId);
            if (resolvedIds.length > 0) {
                node = this.graphStore.getNode(resolvedIds[0]);
            }
        }

        if (!node) {
            return []; // Node not found in graph
        }

        // Bridge to Intent Layer via filePath
        return this.commitStore.getByFile(node.filePath);
    }
}
