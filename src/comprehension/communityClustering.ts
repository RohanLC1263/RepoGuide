
import * as fs from 'fs';
import * as path from 'path';
import { PageRankGraph, PageRankNode } from '../indexing/pageRankGraphBuilder';
import { streamChat } from '../ollama/inferencer';
import { RepositoryContext } from '../context/repositoryContext';

export interface CommunitySummary {
    id: string;
    name: string;
    central_file: string;
    files: string[];
    summary: string;
    generated_at: string;
}

export interface CommunityClusteringOutput {
    communities: CommunitySummary[];
    total_communities: number;
    computed_at: string;
    graph_edges_at_computation?: number;
}

function isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const parts = lower.split('/');
    if (parts.includes('test') || parts.includes('tests') || parts.includes('__tests__')) return true;
    if (parts.includes('docs') || parts.includes('examples') || parts.includes('.github')) return true;
    if (lower.endsWith('.md')) return true;
    if (lower.endsWith('.test.ts') || lower.endsWith('.test.js') || lower.endsWith('.spec.ts') || lower.endsWith('.spec.js')) return true;
    if (lower.includes('.test.') || lower.includes('.spec.')) return true;
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return true;
    return false;
}

export class CommunityClustering {
    private graphPath: string;
    private hashesPath: string;
    private annotationsDir: string;
    private outputPath: string;

    constructor(private repoguideDir: string, private context: RepositoryContext) {
        this.graphPath = path.join(repoguideDir, 'pagerank_graph.json');
        this.hashesPath = path.join(repoguideDir, 'file_hashes.json');
        this.annotationsDir = path.join(repoguideDir, 'annotations');
        this.outputPath = path.join(repoguideDir, 'community_summaries.json');
    }

    private getAnnotation(filePath: string, hashes: Record<string, string>): any {
        const hash = hashes[filePath];
        if (!hash) return null;
        const p = path.join(this.annotationsDir, `${hash}.json`);
        if (!fs.existsSync(p)) return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return null;
        }
    }

    private detectCommunities(graph: PageRankGraph): string[][] {
        const allFiles = Object.keys(graph.nodes).filter(f => !isTestFile(f));
        if (allFiles.length === 0) return [];

        // Step 1: Remove hub nodes (top 5%)
        const sortedByRank = [...allFiles].sort((a, b) => (graph.nodes[b]?.pagerank_score || 0) - (graph.nodes[a]?.pagerank_score || 0));
        const hubCount = Math.floor(allFiles.length * 0.05);
        const hubNodes = new Set(sortedByRank.slice(0, hubCount));
        const nonHubFiles = allFiles.filter(f => !hubNodes.has(f));

        // Step 2: Cluster by directory proximity
        const dirClusters = new Map<string, string[]>();
        for (const f of nonHubFiles) {
            const dir = path.dirname(f);
            if (!dirClusters.has(dir)) dirClusters.set(dir, []);
            dirClusters.get(dir)!.push(f);
        }

        let clusters: string[][] = Array.from(dirClusters.values());

        // Map to quickly find edges
        const adjacency = new Map<string, Set<string>>();
        for (const f of allFiles) adjacency.set(f, new Set());
        for (const edge of graph.edges) {
            if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
                adjacency.get(edge.from)!.add(edge.to);
                adjacency.get(edge.to)!.add(edge.from); // undirected for connection strength
            }
        }

        // Merge clusters with > 3 cross-directory edges
        let merged = true;
        while (merged) {
            merged = false;
            for (let i = 0; i < clusters.length; i++) {
                for (let j = i + 1; j < clusters.length; j++) {
                    let crossEdges = 0;
                    const c1 = clusters[i];
                    const c2 = clusters[j];
                    for (const f1 of c1) {
                        for (const f2 of c2) {
                            if (adjacency.get(f1)!.has(f2)) crossEdges++;
                        }
                    }
                    if (crossEdges > 3) {
                        clusters[i] = [...c1, ...c2];
                        clusters.splice(j, 1);
                        merged = true;
                        break;
                    }
                }
                if (merged) break;
            }
        }

        // Step 3: Enforce max community size (20)
        const splitClusters: string[][] = [];
        for (const cluster of clusters) {
            if (cluster.length > 20) {
                // Split by subdirectory first
                const byDir = new Map<string, string[]>();
                for (const f of cluster) {
                    const d = path.dirname(f);
                    if (!byDir.has(d)) byDir.set(d, []);
                    byDir.get(d)!.push(f);
                }
                for (const dirGroup of byDir.values()) {
                    // If a single directory is still > 20, split it arbitrarily or by PR
                    if (dirGroup.length > 20) {
                        for (let i = 0; i < dirGroup.length; i += 20) {
                            splitClusters.push(dirGroup.slice(i, i + 20));
                        }
                    } else {
                        splitClusters.push(dirGroup);
                    }
                }
            } else {
                splitClusters.push(cluster);
            }
        }

        // Step 4: Add hubs back to their most relevant community
        for (const hub of hubNodes) {
            let bestClusterIdx = -1;
            let maxConnections = -1;
            
            for (let i = 0; i < splitClusters.length; i++) {
                if (splitClusters[i].length >= 20) continue; 
                
                let connections = 0;
                for (const f of splitClusters[i]) {
                    if (adjacency.get(hub)!.has(f)) connections++;
                }
                
                if (connections > maxConnections && connections > 0) {
                    maxConnections = connections;
                    bestClusterIdx = i;
                }
            }
            
            if (bestClusterIdx !== -1) {
                splitClusters[bestClusterIdx].push(hub);
            } else {
                let placed = false;
                for (let i = 0; i < splitClusters.length; i++) {
                    if (splitClusters[i].length < 20) {
                        splitClusters[i].push(hub);
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    splitClusters.push([hub]);
                }
            }
        }

        // Return communities >= 3 files
        return splitClusters.filter(c => c.length >= 3);
    }

    private async generateSummaryForCommunity(community: string[], graph: PageRankGraph, hashes: Record<string, string>): Promise<Omit<CommunitySummary, 'id'>> {
        const sortedFiles = [...community].sort((a, b) => {
            const scoreA = graph.nodes[a]?.pagerank_score || 0;
            const scoreB = graph.nodes[b]?.pagerank_score || 0;
            return scoreB - scoreA;
        });

        const centralFile = sortedFiles[0];
        const annotations = [];

        for (const f of sortedFiles.slice(0, 6)) {
            const ann = this.getAnnotation(f, hashes);
            if (ann) annotations.push(ann);
        }

        const systemPrompt = `You are a strict software architect. You must respond with ONLY a JSON object. No text before or after. No markdown. No explanation. Start your response with { and end it with }. You MUST explicitly name specific classes or functions in your summary.`;

        const userPrompt = `I have a community of related files. The central file is ${centralFile}.
Here are annotations for up to 6 key files in this community:

${JSON.stringify(annotations, null, 2)}

Produce this exact JSON describing the community's architectural role:
{
  "name": "A short descriptive name for this module/community (max 40 chars)",
  "summary": "An architectural description of what this module does. YOU MUST EXPLICITLY NAME AT LEAST TWO SPECIFIC CLASSES OR FUNCTIONS FROM THE ANNOTATIONS."
}

Rules:
- The name should be derived from the central file's role.
- The summary MUST explicitly mention specific classes, functions, or concepts from the annotations.
- Do NOT use generic placeholder language (e.g. "This module handles logic" or "Provides utility functions").
- ONLY output the JSON.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        let raw = '';
        try {
            for await (const chunk of streamChat(this.context, messages)) {
                raw += chunk;
            }

            raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            const firstBrace = raw.indexOf('{');
            const lastBrace = raw.lastIndexOf('}');
            
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                raw = raw.substring(firstBrace, lastBrace + 1);
            }

            const parsed = JSON.parse(raw);
            return {
                name: parsed.name || 'Unknown Module',
                central_file: centralFile,
                files: community,
                summary: parsed.summary || 'Summary unavailable.',
                generated_at: new Date().toISOString()
            };
        } catch (e) {
            this.context.logger.warn(`[Warn] Community LLM failed for central file ${centralFile}: ${e}`);
            return {
                name: 'Fallback Module',
                central_file: centralFile,
                files: community,
                summary: `Community centered around ${centralFile}.`,
                generated_at: new Date().toISOString()
            };
        }
    }

    async clusterAndSummarize(force: boolean = false): Promise<void> {
        if (!fs.existsSync(this.graphPath) || !fs.existsSync(this.hashesPath)) {
            return;
        }

        const graph: PageRankGraph = JSON.parse(await fs.promises.readFile(this.graphPath, 'utf8'));
        const hashes: Record<string, string> = JSON.parse(await fs.promises.readFile(this.hashesPath, 'utf8'));

        let existing: CommunityClusteringOutput | null = null;
        if (fs.existsSync(this.outputPath)) {
            try {
                existing = JSON.parse(await fs.promises.readFile(this.outputPath, 'utf8'));
            } catch (e) {}
        }

        const currentEdges = graph.edges ? graph.edges.length : 0;
        if (!force && existing && existing.graph_edges_at_computation !== undefined) {
            const oldEdges = existing.graph_edges_at_computation;
            const diff = Math.abs(currentEdges - oldEdges);
            if (oldEdges > 0 && (diff / oldEdges) <= 0.10) {
                this.context.logger.info(`[Info] Skipping community clustering (edges changed by <= 10%).`);
                return;
            }
        }

        const communities = this.detectCommunities(graph);
        this.context.logger.info(`Detected ${communities.length} communities.`);

        const output: CommunityClusteringOutput = {
            communities: [],
            total_communities: communities.length,
            computed_at: new Date().toISOString(),
            graph_edges_at_computation: currentEdges
        };

        let i = 0;
        for (const comm of communities) {
            const summary = await this.generateSummaryForCommunity(comm, graph, hashes);
            output.communities.push({
                id: `comm_${i++}`,
                ...summary
            });
        }

        await fs.promises.writeFile(this.outputPath, JSON.stringify(output, null, 2), 'utf8');
        this.context.logger.info(`Wrote community summaries to ${this.outputPath}`);
    }
}
