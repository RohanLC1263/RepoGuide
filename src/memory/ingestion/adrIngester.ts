import { MemoryProposal } from "./memoryProposal";
import { MemoryIngestionPipeline } from "./memoryIngestionPipeline";
import * as path from "path";
import { ADRParser } from "../../intent/adr/adrParser";

/**
 * Pure path-pattern check, deliberately standalone (not an AdrIngester instance
 * method) so callers can filter out non-ADR files BEFORE constructing an
 * AdrIngester. Security review finding F1: constructing an AdrIngester (via
 * indexManager.ts's getAdrIngester()) transitively initializes
 * LocalEmbeddingProvider, which downloads a model from huggingface.co on first
 * use -- that download must only fire for files that are actually ADRs, not on
 * the first file of every indexing run regardless of type.
 */
export function isAdrFilePath(absolutePath: string, workspaceRoot: string): boolean {
    const relPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
    return /^(docs\/adrs?|adrs?|architecture\/decisions)\/[^\/]+\.md$/i.test(relPath);
}

/**
 * Legacy wrapper for Vector-based ADR ingestion.
 * In the new Dual-Write Architecture, ADRs are first-class entities in SQLite,
 * but this file continues to feed the semantic Vector DB for RAG queries.
 */
export class AdrIngester {
    private parser = new ADRParser();

    constructor(private readonly pipeline: MemoryIngestionPipeline) {}

    public isAdrFile(absolutePath: string, workspaceRoot: string): boolean {
        return isAdrFilePath(absolutePath, workspaceRoot);
    }

    public async processFile(absolutePath: string, content: string, repositoryId: string, workspaceRoot: string): Promise<void> {
        if (!this.isAdrFile(absolutePath, workspaceRoot)) return;
        
        const relPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
        
        // Use the new advanced parser to get strict status
        const { adr } = this.parser.parse(content, relPath, repositoryId);
        
        let isStale = false;
        if (adr.status === "SUPERSEDED" || adr.status === "DEPRECATED" || adr.status === "REJECTED") {
            isStale = true;
        }

        // Push to the legacy Vector pipeline
        const proposal: MemoryProposal = {
            externalId: relPath,
            content: `Title: ${adr.title}\nStatus: ${adr.status}\nContext: ${adr.context}\nDecision: ${adr.decision}\nConsequences: ${adr.consequences}`,
            source: "adr",
            action: "update",
            stale: isStale,
            scope: "repository",
            scopeKeys: [relPath],
            tags: ["adr", "architecture"],
            confidence: adr.parserConfidence === "HIGH" ? 1.0 : 0.5,
            repositoryId
        };
        
        await this.pipeline.ingest(proposal);
    }

    public async processDelete(absolutePath: string, repositoryId: string, workspaceRoot: string): Promise<void> {
        if (!this.isAdrFile(absolutePath, workspaceRoot)) return;
        
        const relPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
        
        const proposal: MemoryProposal = {
            externalId: relPath,
            content: "",
            source: "adr",
            action: "mark_stale",
            stale: true,
            scope: "repository",
            scopeKeys: [relPath],
            tags: ["adr", "architecture"],
            confidence: 1.0,
            repositoryId
        };
        
        await this.pipeline.ingest(proposal);
    }
}
