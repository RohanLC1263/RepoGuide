import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex } from './symbolIndex';
import Parser = require('node-tree-sitter');
import { getTreeSitterLanguage } from './languageDetector';

export interface PageRankNode {
    pagerank_score: number;
    out_degree: number;
    in_degree: number;
}

export interface PageRankEdge {
    from: string;
    to: string;
    weight: number;
    symbols: string[];
}

export interface PageRankGraph {
    nodes: Record<string, PageRankNode>;
    edges: PageRankEdge[];
    computed_at: string;
    total_files: number;
}

const BUILT_INS = new Set([
    'constructor', 'prototype', 'length', 'toString', 'valueOf', 
    'call', 'apply', 'bind', 'get', 'set', 'has', 'delete', 'clear'
]);

const DOM_GLOBALS = new Set([
    'open', 'send', 'close', 'write', 'read', 'error', 
    'data', 'then', 'catch', 'next', 'done'
]);

function isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    const parts = lower.split('/');
    if (parts.includes('test') || parts.includes('tests') || parts.includes('__tests__')) return true;
    if (parts.includes('docs') || parts.includes('examples')) return true;
    if (lower.endsWith('.test.ts') || lower.endsWith('.test.js') || lower.endsWith('.spec.ts') || lower.endsWith('.spec.js')) return true;
    if (lower.includes('.test.') || lower.includes('.spec.')) return true;
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return true;
    return false;
}

function isGenericIdentifier(ident: string): boolean {
    if (ident.length < 4) return true;
    if (BUILT_INS.has(ident)) return true;
    if (DOM_GLOBALS.has(ident)) return true;
    return false;
}

function normalizePath(p: string, workspaceRoot: string): string {
    const normalized = p.replace(/\\/g, '/');
    const root = workspaceRoot.replace(/\\/g, '/');
    return normalized.toLowerCase().startsWith(root.toLowerCase() + '/') ? normalized.slice(root.length + 1) : normalized;
}

export class PageRankGraphBuilder {
    private graphPath: string;
    private cachePath: string;
    private cache: Record<string, string[]> = {};

    constructor(private repoguideDir: string, private workspaceRoot: string, private symbolIndex: SymbolIndex) {
        this.graphPath = path.join(repoguideDir, 'pagerank_graph.json');
        this.cachePath = path.join(repoguideDir, 'pagerank_cache.json');
    }

    async init(): Promise<void> {
        if (fs.existsSync(this.cachePath)) {
            try {
                this.cache = JSON.parse(await fs.promises.readFile(this.cachePath, 'utf8'));
            } catch (e) {
                this.cache = {};
            }
        }
    }

    private async saveCache(): Promise<void> {
        await fs.promises.writeFile(this.cachePath, JSON.stringify(this.cache), 'utf8');
    }

    private extractIdentifiers(content: string, language: string): string[] {
        const identifiers = new Set<string>();
        const LanguageModule = getTreeSitterLanguage(language);
        if (LanguageModule) {
            const parser = new Parser();
            try {
                parser.setLanguage(LanguageModule);
                const tree = parser.parse(content);
                function processNode(node: Parser.SyntaxNode) {
                    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
                        if (node.text.length >= 3) {
                            identifiers.add(node.text);
                        }
                    }
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i);
                        if (child) {
                            processNode(child);
                        }
                    }
                }
                processNode(tree.rootNode);
                return Array.from(identifiers);
            } catch (e) { }
        }
        
        const words = content.match(/[A-Za-z_$][\w$]*/g);
        if (words) {
            for (const w of words) {
                if (w.length >= 3) identifiers.add(w);
            }
        }
        return Array.from(identifiers);
    }

    async updateFile(filePath: string, content: string, language: string): Promise<void> {
        const relPath = normalizePath(filePath, this.workspaceRoot);
        this.cache[relPath] = this.extractIdentifiers(content, language);
        await this.saveCache();
    }

    async removeFile(filePath: string): Promise<void> {
        const relPath = normalizePath(filePath, this.workspaceRoot);
        delete this.cache[relPath];
        await this.saveCache();
    }

    async clearAll(): Promise<void> {
        this.cache = {};
        if (fs.existsSync(this.cachePath)) {
            try { await fs.promises.unlink(this.cachePath); } catch (e) {}
        }
        if (fs.existsSync(this.graphPath)) {
            try { await fs.promises.unlink(this.graphPath); } catch (e) {}
        }
    }

    async buildGraph(allFiles: string[], seedFiles: string[] = []): Promise<PageRankGraph> {
        const edgesMap = new Map<string, PageRankEdge>();
        const nodes: Record<string, PageRankNode> = {};
        const validFiles = new Set(allFiles
            .map(f => normalizePath(f, this.workspaceRoot))
            .filter(f => !isTestFile(f))
        );

        for (const file of validFiles) {
            nodes[file] = { pagerank_score: 0, out_degree: 0, in_degree: 0 };
        }

        // Compute document frequency for filtering >30% frequency
        const dfMap = new Map<string, number>();
        let cachedFilesCount = 0;
        for (const [fromRelFile, identifiers] of Object.entries(this.cache)) {
            if (!validFiles.has(fromRelFile)) continue;
            cachedFilesCount++;
            for (const ident of new Set(identifiers)) {
                dfMap.set(ident, (dfMap.get(ident) || 0) + 1);
            }
        }
        const threshold = cachedFilesCount * 0.3;

        // Generate edges
        for (const [fromRelFile, identifiers] of Object.entries(this.cache)) {
            if (!validFiles.has(fromRelFile)) continue;

            for (const ident of identifiers) {
                if (isGenericIdentifier(ident)) continue;
                if ((dfMap.get(ident) || 0) > threshold) continue;

                const definedIn1 = this.symbolIndex.lookup(ident) || [];
                const lowerIdent = ident.toLowerCase();
                const definedIn2 = ident !== lowerIdent ? (this.symbolIndex.lookup(lowerIdent) || []) : [];
                const titleIdent = ident.charAt(0).toUpperCase() + ident.slice(1);
                const definedIn3 = ident !== titleIdent ? (this.symbolIndex.lookup(titleIdent) || []) : [];
                
                const allDefs = [...definedIn1, ...definedIn2, ...definedIn3];
                // Deduplicate by filePath
                const uniqueDefs = new Map<string, any>();
                for (const def of allDefs) {
                    uniqueDefs.set(def.filePath, def);
                }
                const definedIn = Array.from(uniqueDefs.values());

                for (const def of definedIn) {
                    const toRelFile = normalizePath(def.filePath, this.workspaceRoot);
                    if (!validFiles.has(toRelFile)) continue;
                    if (fromRelFile === toRelFile) continue; // Skip self-loops

                    const edgeKey = `${fromRelFile}->${toRelFile}`;
                    let edge = edgesMap.get(edgeKey);
                    if (!edge) {
                        edge = { from: fromRelFile, to: toRelFile, weight: 0, symbols: [] };
                        edgesMap.set(edgeKey, edge);
                    }
                    if (!edge.symbols.includes(ident)) {
                        edge.symbols.push(ident);
                        edge.weight += 1;
                    }
                }
            }
        }

        const edges = Array.from(edgesMap.values());
        
        for (const edge of edges) {
            nodes[edge.from].out_degree += edge.weight;
            nodes[edge.to].in_degree += edge.weight;
        }

        // PageRank algorithm
        const d = 0.85;
        const maxIterations = 100;
        const tol = 1e-6;
        const N = validFiles.size;
        
        if (N > 0) {
            // Initialize scores
            const initialScore = 1.0 / N;
            for (const file of validFiles) {
                nodes[file].pagerank_score = initialScore;
            }

            // Create adjacency list for faster computation
            const outEdges: Record<string, {to: string, weight: number}[]> = {};
            for (const file of validFiles) {
                outEdges[file] = [];
            }
            for (const edge of edges) {
                outEdges[edge.from].push({ to: edge.to, weight: edge.weight });
            }

            // Precompute personalized probabilities
            const pVector: Record<string, number> = {};
            const normalizedSeeds = seedFiles.map(f => normalizePath(f, this.workspaceRoot)).filter(f => validFiles.has(f));
            if (normalizedSeeds.length > 0) {
                for (const file of validFiles) {
                    pVector[file] = normalizedSeeds.includes(file) ? 1.0 / normalizedSeeds.length : 0.0;
                }
            } else {
                for (const file of validFiles) {
                    pVector[file] = 1.0 / N;
                }
            }

            for (let iter = 0; iter < maxIterations; iter++) {
                let diff = 0;
                const newScores: Record<string, number> = {};
                let danglingSum = 0;

                for (const file of validFiles) {
                    newScores[file] = 0;
                    if (nodes[file].out_degree === 0) {
                        danglingSum += nodes[file].pagerank_score;
                    }
                }

                for (const file of validFiles) {
                    const score = nodes[file].pagerank_score;
                    if (nodes[file].out_degree > 0) {
                        const outDegree = nodes[file].out_degree;
                        for (const target of outEdges[file]) {
                            newScores[target.to] += d * score * (target.weight / outDegree);
                        }
                    }
                }

                for (const file of validFiles) {
                    newScores[file] += (1.0 - d) * pVector[file] + d * danglingSum * pVector[file];
                    diff += Math.abs(newScores[file] - nodes[file].pagerank_score);
                }

                for (const file of validFiles) {
                    nodes[file].pagerank_score = newScores[file];
                }

                if (diff < tol) {
                    break;
                }
            }
        }

        const graph: PageRankGraph = {
            nodes,
            edges,
            computed_at: new Date().toISOString(),
            total_files: validFiles.size
        };

        await fs.promises.writeFile(this.graphPath, JSON.stringify(graph, null, 2), 'utf8');
        return graph;
    }
}
