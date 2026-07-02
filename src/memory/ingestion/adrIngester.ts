import { MemoryProposal } from "./memoryProposal";
import { MemoryIngestionPipeline } from "./memoryIngestionPipeline";
import * as path from "path";
import { ADRParser } from "../../intent/adr/adrParser";

/**
 * Legacy wrapper for Vector-based ADR ingestion.
 * In the new Dual-Write Architecture, ADRs are first-class entities in SQLite,
 * but this file continues to feed the semantic Vector DB for RAG queries.
 */
export class AdrIngester {
    private parser = new ADRParser();

    constructor(private readonly pipeline: MemoryIngestionPipeline) {}

    public isAdrFile(absolutePath: string, workspaceRoot: string): boolean {
        const relPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
        return /^(docs\/adrs?|adrs?|architecture\/decisions)\/[^\/]+\.md$/i.test(relPath);
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
