import * as path from 'path';

export interface RepositoryArtifactPaths {
    workspaceRoot: string;
    repoguideDir: string;
    lanceDbDir: string;
    bm25Index: string;
    logicalUnitBm25Index: string;
    logicalUnitsDb: string;
    factsDb: string;
    symbols: string;
    manifest: string;
    programGraph: string;
    pageRankGraph: string;
    repositoryBrainDb: string;
    understandingDir: string;
    preparationReport: string;
}

export function getRepositoryArtifactPaths(workspaceRoot: string, repoguideDir?: string): RepositoryArtifactPaths {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedRepoGuideDir = path.resolve(repoguideDir ?? path.join(resolvedRoot, '.repoguide'));
    return {
        workspaceRoot: resolvedRoot,
        repoguideDir: resolvedRepoGuideDir,
        lanceDbDir: resolvedRepoGuideDir,
        bm25Index: path.join(resolvedRepoGuideDir, 'bm25_index.json'),
        logicalUnitBm25Index: path.join(resolvedRepoGuideDir, 'logical_unit_bm25.json'),
        logicalUnitsDb: path.join(resolvedRepoGuideDir, 'logical_units.db'),
        factsDb: path.join(resolvedRepoGuideDir, 'facts.db'),
        symbols: path.join(resolvedRepoGuideDir, 'symbols.json'),
        manifest: path.join(resolvedRepoGuideDir, 'manifest.json'),
        programGraph: path.join(resolvedRepoGuideDir, 'graph', 'graph.json'),
        pageRankGraph: path.join(resolvedRepoGuideDir, 'pagerank_graph.json'),
        repositoryBrainDb: path.join(resolvedRepoGuideDir, 'repository_brain.sqlite'),
        understandingDir: path.join(resolvedRepoGuideDir, 'understanding'),
        preparationReport: path.join(resolvedRepoGuideDir, 'repository_readiness.json')
    };
}
