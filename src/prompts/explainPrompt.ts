import * as path from 'path';
import { ArchitectureContext, ConceptSearchResult, FileUnderstanding, FlowContext, ModuleUnderstanding, ProjectUnderstanding } from '../comprehension/types';
import { Message } from '../query/conversationHistory';
import { CodeChunk, SymbolEntry } from '../store/storeTypes';

export interface ExplainSelectionPromptInput {
    filePath: string;
    question?: string;
    language: string;
    startLine: number;
    endLine: number;
    selectedText: string;
    anchorChunks: CodeChunk[];
    relatedChunks: CodeChunk[];
    selectedSymbols: SymbolEntry[];
    projectUnderstanding?: ProjectUnderstanding | null;
    fileUnderstanding?: FileUnderstanding | null;
    moduleUnderstanding?: ModuleUnderstanding | null;
    architectureContext?: ArchitectureContext | null;
    conceptResults?: ConceptSearchResult[];
    flowContext?: FlowContext | null;
    history?: Message[];
}

export function buildExplainSelectionMessages(
    input: ExplainSelectionPromptInput
): Array<{ role: string; content: string }> {
    const history = input.history ?? [];
    const conceptResults = (input.conceptResults ?? []).filter(result => result.matchScore > 0.65).slice(0, 5);
    const anchorChunks = dedupeChunks(input.anchorChunks);
    const relatedChunks = dedupeChunks(input.relatedChunks).filter(chunk =>
        !anchorChunks.some(anchor => anchor.id === chunk.id)
    );

    const contextSections: string[] = [];
    contextSections.push(
        'SELECTED CODE:',
        `[FILE: ${input.filePath} LINES: ${input.startLine + 1}-${input.endLine + 1}]`,
        input.selectedText.trim() || '(empty selection)'
    );

    if (input.selectedSymbols.length > 0) {
        contextSections.push(
            '',
            'SELECTED SYMBOLS:',
            ...input.selectedSymbols.slice(0, 5).map(symbol =>
                `${symbol.name} (${symbol.kind}) at ${path.basename(symbol.filePath)}:${symbol.startLine + 1}-${symbol.endLine + 1}`
            )
        );
    }

    if (input.fileUnderstanding) {
        contextSections.push(
            '',
            'FILE ROLE:',
            `${path.basename(input.filePath)}: ${input.fileUnderstanding.purpose}`,
            input.fileUnderstanding.key_concepts.length > 0
                ? `Key concepts: ${input.fileUnderstanding.key_concepts.slice(0, 6).join(', ')}`
                : ''
        );
    }

    if (input.projectUnderstanding) {
        contextSections.push(
            '',
            'PROJECT CONTEXT:',
            input.projectUnderstanding.purpose,
            `Architecture: ${input.projectUnderstanding.architecture_type}`,
            `Data flow: ${input.projectUnderstanding.data_flow}`
        );
    }

    if (input.architectureContext || input.moduleUnderstanding) {
        contextSections.push('', 'MODULE CONTEXT:');
        
        if (input.moduleUnderstanding) {
            contextSections.push(
                `${input.moduleUnderstanding.modulePath}: ${input.moduleUnderstanding.modulePurpose}`
            );
            if (input.moduleUnderstanding.responsibilities && input.moduleUnderstanding.responsibilities.length > 0) {
                contextSections.push(
                    `Responsibilities: ${input.moduleUnderstanding.responsibilities.slice(0, 3).join(', ')}`
                );
            }
        }

        if (input.architectureContext) {
            const filteredModules = input.architectureContext.relevantModules
                .filter(m => !input.moduleUnderstanding || m.modulePath !== input.moduleUnderstanding.modulePath)
                .slice(0, 5);
                
            if (filteredModules.length > 0) {
                contextSections.push(
                    ...filteredModules.map(module =>
                        `${module.modulePath}: ${module.modulePurpose}`
                    )
                );
            }
        }
    }

    if (conceptResults.length > 0) {
        contextSections.push(
            '',
            'CONCEPT CONTEXT:',
            ...conceptResults.map(result =>
                `"${result.matchedConcept}" -> ${result.location.filePath}${result.location.symbolName ? ` (${result.location.symbolName})` : ''}`
            )
        );
    }

    if (input.flowContext && input.flowContext.contextBlocks.length > 0) {
        const realBlocks = input.flowContext.contextBlocks
            .filter(block => block.filePath !== 'behavioral_path_context')
            .slice(0, 8);
        if (realBlocks.length > 0) {
            contextSections.push(
                '',
                'FLOW CONTEXT:',
                ...realBlocks.map((block, index) =>
                    `${index + 1}. ${block.functionName}() in ${path.basename(block.filePath)} → ${block.callsNext}`
                )
            );
            if (realBlocks.some(b => b.callsNext.includes('[INFERRED]'))) {
                contextSections.push(
                    '',
                    'NOTE: Steps marked [INFERRED] are based on LLM analysis, not static call graph tracing.'
                );
            }
        }
    }

    if (anchorChunks.length > 0) {
        contextSections.push(
            '',
            'LOCAL CODE CONTEXT:',
            ...anchorChunks.flatMap(chunk => [
                `[FILE: ${chunk.filePath} LINES: ${chunk.startLine + 1}-${chunk.endLine + 1}]`,
                chunk.text,
                '---'
            ])
        );
    }

    if (relatedChunks.length > 0) {
        contextSections.push(
            '',
            'RELATED PROJECT CONTEXT:',
            ...relatedChunks.slice(0, 6).flatMap(chunk => [
                `[FILE: ${chunk.filePath} LINES: ${chunk.startLine + 1}-${chunk.endLine + 1}]`,
                chunk.text,
                '---'
            ])
        );
    }

    const systemPrompt = [
        'You are RepoGuide, a staff-level engineer mentoring a developer through selected code in the context of the whole repository.',
        'Your job is not just to describe the snippet. Explain what it does, why it exists, where it fits, and how it interacts with the surrounding system.',
        'Address the developer directly as "you" when guidance is useful. Be concise, specific, and grounded in the files and symbols shown.',
        '',
        'EVIDENCE HIERARCHY — follow this strictly when forming your answer:',
        '1. DIRECT CODE EVIDENCE: You have seen the actual source code. Describe what it does',
        '   with certainty. Say "The code in [file] shows..." or "In [function], the implementation..."',
        '2. GRAPH-DERIVED CONTEXT: Structural relationships (call chains, imports) extracted from',
        '   the code. State these confidently but note they are structural analysis.',
        '   Say "Based on the call graph, this flows through..." or "The import analysis shows..."',
        '3. SYNTHESIS CONTEXT: RepoGuide\'s automated analysis of the codebase. These are inferences',
        '   generated by analyzing the code, not the code itself. Qualify appropriately.',
        '   Say "RepoGuide\'s analysis indicates..." or "Based on the module summary..."',
        '4. If you reason beyond the provided context, say so explicitly.',
        'NEVER use visible bracket labels like [CODE], [INFERRED], [SYNTHESIS] in your answer.',
        'Express provenance through natural language as shown above.',
        '',
        'Use only the provided repository context.',
        'If the surrounding system role is clear from context, say it confidently.',
        'If something is uncertain, say what is known from the code and what remains unclear. Never say "As an AI".',
        '',
        'Write in exactly these four section headings:',
        'WHAT IT DOES',
        'WHERE IT FITS',
        'HOW IT RUNS',
        'WATCHPOINTS',
        '',
        'Rules:',
        '- Ground the explanation in the selected code first, then connect it to the project context.',
        '- Name the project (from PROJECT CONTEXT) when explaining why the code exists and what problem it solves for the project.',
        '- Preserve important names from the selected code, especially callback roles, object fields, parameters, and method names such as fulfilled, rejected, handlers, baseURL, or relativeURL when they appear in context.',
        '- For helper predicates or URL utilities, explain the caller decision the helper enables when that is visible in related context, such as whether to prepend baseURL or leave an absolute URL unchanged.',
        '- Mention file names and symbol names naturally when useful.',
        '- When the selected code defines a base interface or abstract class, explain the concrete implementations or adapters shown in context and what they let callers abstract over. Name the specific backing stores or strategies each implementation wraps (e.g., disk, ZIP archive, in-memory).',
        '- Do not invent dependencies, entry points, or side effects.',
        '- Prefer concrete explanation over generic framework talk.',
        '- Keep the answer concise but insight-dense.',
        '',
        contextSections.filter(Boolean).join('\n')
    ].join('\n');

    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: systemPrompt }];
    for (const message of history) {
        messages.push({ role: message.role, content: message.content });
    }
    messages.push({
        role: 'user',
        content: [
            input.question
                ? `User question: ${input.question}`
                : `Explain the selected ${input.language} code in project context.`,
            'You MUST use exactly the four section headings: WHAT IT DOES, WHERE IT FITS, HOW IT RUNS, and WATCHPOINTS.',
            'Keep your explanation concise (max 300 words).'
        ].join('\n')
    });
    return messages;
}

function dedupeChunks(chunks: CodeChunk[]): CodeChunk[] {
    const seen = new Set<string>();
    return chunks.filter(chunk => {
        if (seen.has(chunk.id)) {
            return false;
        }
        seen.add(chunk.id);
        return true;
    });
}
