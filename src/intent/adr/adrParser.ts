import { ADREntity, ADRReference, ADRStatus } from './adrTypes';
import { createHash } from 'crypto';

export class ADRParser {
    public parse(content: string, relPath: string, repositoryId: string): { adr: ADREntity, references: ADRReference[] } {
        const id = this.extractIdFromPath(relPath);
        const sourceHash = createHash('sha256').update(content).digest('hex');
        
        let context = "";
        let decision = "";
        let consequences = "";
        let status: ADRStatus = "PROPOSED";
        let parserConfidence: "HIGH" | "LOW" = "HIGH";

        // Title Extraction (First header)
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : id;

        // Status Extraction
        const statusMatch = content.match(/(?:^|\n)#{1,6}\s*Status\s*([\s\S]*?)(?=\n##\s+(?:Context|Decision|Consequences|Compliance|Status|Notes|Decision Drivers|Considered Options|References)\b|$)/i);
        if (statusMatch) {
            const statusText = statusMatch[1].toLowerCase();
            if (statusText.includes("superseded")) status = "SUPERSEDED";
            else if (statusText.includes("deprecated") || statusText.includes("obsolete")) status = "DEPRECATED";
            else if (statusText.includes("rejected")) status = "REJECTED";
            else if (statusText.includes("accepted")) status = "ACCEPTED";
            else status = "PROPOSED"; // default if unsure
        }

        // Context Extraction
        const contextMatch = content.match(/(?:^|\n)#{1,6}\s*Context\s*([\s\S]*?)(?=\n##\s+(?:Context|Decision|Consequences|Compliance|Status|Notes|Decision Drivers|Considered Options|References)\b|$)/i);
        if (contextMatch) {
            context = contextMatch[1].trim();
        }

        // Decision Extraction
        const decisionMatch = content.match(/(?:^|\n)#{1,6}\s*(?:Decision|Decision Outcome)\s*([\s\S]*?)(?=\n##\s+(?:Context|Decision|Consequences|Compliance|Status|Notes|Decision Drivers|Considered Options|References)\b|$)/i);
        if (decisionMatch) {
            decision = decisionMatch[1].trim();
        }

        // Consequences Extraction
        const consequencesMatch = content.match(/(?:^|\n)#{1,6}\s*Consequences\s*([\s\S]*?)(?=\n##\s+(?:Context|Decision|Consequences|Compliance|Status|Notes|Decision Drivers|Considered Options|References)\b|$)/i);
        if (consequencesMatch) {
            consequences = consequencesMatch[1].trim();
        }

        // Fallback check
        if (!contextMatch && !decisionMatch && !consequencesMatch) {
            parserConfidence = "LOW";
            decision = content.substring(0, 2000); // Raw body fallback
        }

        const adr: ADREntity = {
            id,
            number: this.extractNumber(id),
            title,
            status,
            context,
            decision,
            consequences,
            sourcePath: relPath,
            sourceHash,
            repositoryId,
            parserConfidence,
            rawContent: content
        };

        const references = this.extractReferences(content, id);

        return { adr, references };
    }

    private extractIdFromPath(relPath: string): string {
        // e.g. docs/adr/0014-use-json.md -> 0014-use-json
        const parts = relPath.split(/[/\\]/);
        const filename = parts[parts.length - 1];
        return filename.replace(/\.md$/, '');
    }

    private extractNumber(id: string): string | undefined {
        const match = id.match(/^(\d+)-/);
        return match ? match[1] : undefined;
    }

    private extractReferences(content: string, sourceId: string): ADRReference[] {
        const references: ADRReference[] = [];
        
        // Match Markdown links to other ADRs e.g., [ADR 012](0012-some-adr.md)
        // Also look for explicit text like "Supersedes ADR-012"
        const linkRegex = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
        let match;
        while ((match = linkRegex.exec(content)) !== null) {
            const targetPath = match[2];
            // Infer relation. We can do simple heuristic checks on surrounding text.
            let relation: "SUPERSEDES" | "SUPERSEDED_BY" | "REFERENCES" = "REFERENCES";
            
            const contextStart = Math.max(0, match.index - 50);
            const contextString = content.substring(contextStart, match.index).toLowerCase();
            
            if (contextString.includes("supersedes")) relation = "SUPERSEDES";
            else if (contextString.includes("superseded by")) relation = "SUPERSEDED_BY";

            const targetId = targetPath.replace(/^.*[/\\]/, '').replace(/\.md$/, '');
            references.push({ sourceAdrId: sourceId, targetAdrId: targetId, relation });
        }

        return references;
    }
}
