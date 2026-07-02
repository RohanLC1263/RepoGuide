import { PullRequestStore } from './pullRequestStore';
import { PullRequestEntity } from './prTypes';
import { ProgramGraphStore } from '../../store/programGraphStore';

export class PRQueryEngine {
    constructor(
        private prStore: PullRequestStore,
        private graphStore: ProgramGraphStore
    ) {}

    /**
     * Retrieve a specific PR by its ID.
     */
    public getPR(id: string): PullRequestEntity | null {
        return this.prStore.getById(id);
    }

    /**
     * Retrieve all PRs that modified a specific file path.
     */
    public getPRsForFile(path: string): PullRequestEntity[] {
        return this.prStore.getPRsForFile(path);
    }

    /**
     * Future-facing API: Bridges the structural Graph Layer with the Intent Layer.
     * Resolves a symbol (or AST node ID) to its physical file, then looks up PRs that touched that file.
     */
    public getPRsForNode(symbolOrId: string): PullRequestEntity[] {
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
        // Note: The filePath in the graph must match the path formats stored in PR files
        return this.prStore.getPRsForFile(node.filePath);
    }

    /**
     * Retrieves PRs by author (stubbed for V1).
     */
    public getPRsByAuthor(author: string): PullRequestEntity[] {
        throw new Error("Deferred: getPRsByAuthor is not implemented in V1");
    }

    /**
     * Full-text search across PR bodies and comments (stubbed for V1).
     */
    public searchPRs(query: string): PullRequestEntity[] {
        throw new Error("Deferred: searchPRs requires FTS extensions and is not implemented in V1");
    }
}
