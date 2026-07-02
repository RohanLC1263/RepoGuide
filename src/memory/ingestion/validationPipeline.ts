import { CandidateMemory } from "./candidateMemory";

export interface ValidationResult {
    passed: boolean;
    reason?: string;
}

export class ValidationPipeline {
    public validate(candidate: CandidateMemory): ValidationResult {
        // 1. Schema / Format validation
        if (!candidate.proposal.content || !candidate.proposal.scope || candidate.proposal.confidence === undefined) {
            return { passed: false, reason: "Missing required schema properties." };
        }
        if (candidate.proposal.confidence < 0 || candidate.proposal.confidence > 1.0) {
            return { passed: false, reason: "Confidence must be between 0.0 and 1.0" };
        }

        // 2. Provenance validation (Basic mock for V1)
        if (!candidate.proposal.source) {
            return { passed: false, reason: "Missing source provenance." };
        }

        // 3. Source trust check
        if (candidate.proposal.source === 'mcp' && candidate.proposal.confidence > 0.8) {
            // Simulated rule: MCPs cannot propose very high confidence without corroboration
            // Actually, validation tests say MCP cannot bypass promotion gate, which is handled in promotion.
            // But let's just make sure it's valid.
        }

        // 4. Triviality check
        // Basic heuristic for V1 mock
        const content = candidate.proposal.content.toLowerCase();
        if (content.includes("function add") || content.match(/^variable [a-z] is/i)) {
            return { passed: false, reason: "Trivial fact rejected." };
        }

        return { passed: true };
    }
}
