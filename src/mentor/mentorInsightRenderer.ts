import { MentorExplanationContext, ArchitectureRecommendation, ChangeRecommendation, OnboardingRecommendation, RefactoringRecommendation } from './mentorTypes';

export class MentorInsightRenderer {
    public render(context: MentorExplanationContext): string {
        const type = context.recommendation.type;
        switch (type) {
            case 'architecture':
                return this.renderArchitectureInsights(context.recommendation, context.reasoningFactors);
            case 'change':
                return this.renderChangeInsights(context.recommendation, context.reasoningFactors);
            case 'onboarding':
                return this.renderOnboardingInsights(context.recommendation, context.reasoningFactors);
            case 'refactoring':
                return this.renderRefactoringInsights(context.recommendation, context.reasoningFactors);
            default:
                return '';
        }
    }

    private cleanReasoningFactors(factors: string[]): string[] {
        const cleaned: string[] = [];
        for (const factor of factors) {
            // Filter out exact scores and internal diagnostic statements
            if (factor.includes('Computed Risk Score:')) {continue;}
            if (factor.startsWith('Sorted') && factor.includes('structural importance metrics')) {continue;}
            if (factor.startsWith('Categorized') && factor.includes('heuristic naming tiers')) {continue;}
            if (factor.startsWith('Analyzed') && factor.includes('dependencies to find large modules')) {continue;}

            let text = factor;
            // Clean up remaining threshold or raw metric mentions
            text = text.replace(/\s*\(Thresholds:[^\)]+\)/g, '');
            text = text.replace(/\s*due to high structural reference frequency \(\d+\)/g, '');
            text = text.replace(/\s*\(frequency >= \d+\)/g, '');
            text = text.replace(/\s*\(>500 lines\)/g, '');

            // Convert raw "Risk Level: XXX" to a friendlier sentence
            if (text.startsWith('Risk Level:')) {
                const level = text.replace('Risk Level:', '').trim();
                text = `This change carries a ${level.toLowerCase()} risk level.`;
            }

            if (text) {
                cleaned.push(text);
            }
        }
        return cleaned;
    }

    /**
     * Single shared gate for every insight block: a fixed narrative-summary string
     * (e.g. "Architecture revolves around core components, prioritizing 0 files as
     * structural entry points.") is never itself evidence of anything substantive --
     * it's a template that still produces non-empty text even when every underlying
     * list is empty. Found dogfooding against a real project: this degenerate case
     * rendered as a nonsensical trailing sentence appended to an otherwise-good
     * answer. A block only earns its section header if at least one real, structured
     * list has content, or there's a real (non-templated) reasoning factor to show.
     */
    private hasSubstantiveContent(lists: unknown[][], factors: string[]): boolean {
        return lists.some(list => list.length > 0) || this.cleanReasoningFactors(factors).length > 0;
    }

    private renderArchitectureInsights(rec: ArchitectureRecommendation, factors: string[]): string {
        if (!this.hasSubstantiveContent([rec.majorComponents, rec.importantFiles, rec.suggestedReadingOrder], factors)) {
            return '';
        }

        const lines: string[] = [];
        lines.push('\n\n### Architecture Insights\n');

        if (rec.architectureSummary) {
            lines.push(`${rec.architectureSummary}\n`);
        }

        if (rec.majorComponents && rec.majorComponents.length > 0) {
            lines.push('**Major Components**');
            rec.majorComponents.slice(0, 5).forEach(c => lines.push(`- ${c}`));
            lines.push('');
        }
        
        if (rec.importantFiles && rec.importantFiles.length > 0) {
            lines.push('**Important Files**');
            rec.importantFiles.slice(0, 5).forEach(f => lines.push(`- ${f}`));
            lines.push('');
        }
        
        if (rec.suggestedReadingOrder && rec.suggestedReadingOrder.length > 0) {
            lines.push('**Suggested Reading Order**');
            rec.suggestedReadingOrder.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
            lines.push('');
        }
        
        const cleanFactors = this.cleanReasoningFactors(factors);
        if (cleanFactors.length > 0) {
            lines.push('**Reasoning**');
            cleanFactors.forEach(f => lines.push(`- ${f}`));
        }

        return lines.join('\n');
    }

    private renderChangeInsights(rec: ChangeRecommendation, factors: string[]): string {
        if (!this.hasSubstantiveContent([rec.affectedFiles, rec.affectedSymbols], factors)) {
            return '';
        }

        const lines: string[] = [];
        lines.push('\n\n### Change Impact Analysis\n');
        
        const cleanFactors = this.cleanReasoningFactors(factors);
        if (cleanFactors.length > 0) {
            cleanFactors.forEach(f => lines.push(`${f}\n`));
        }

        if (rec.affectedFiles && rec.affectedFiles.length > 0) {
            lines.push('**Affected Files**');
            rec.affectedFiles.slice(0, 5).forEach(f => lines.push(`- ${f}`));
            if (rec.affectedFiles.length > 5) {
                lines.push(`- ...and ${rec.affectedFiles.length - 5} more`);
            }
            lines.push('');
        }

        if (rec.affectedSymbols && rec.affectedSymbols.length > 0) {
            lines.push('**Affected Symbols**');
            rec.affectedSymbols.slice(0, 5).forEach(s => lines.push(`- ${s}`));
            if (rec.affectedSymbols.length > 5) {
                lines.push(`- ...and ${rec.affectedSymbols.length - 5} more`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    private renderOnboardingInsights(rec: OnboardingRecommendation, factors: string[]): string {
        if (!this.hasSubstantiveContent([rec.firstFiles, rec.learningPath], factors)) {
            return '';
        }

        const lines: string[] = [];
        lines.push('\n\n### Recommended Learning Path\n');
        
        const cleanFactors = this.cleanReasoningFactors(factors);
        if (cleanFactors.length > 0) {
            cleanFactors.forEach(f => lines.push(`${f}\n`));
        }

        if (rec.firstFiles && rec.firstFiles.length > 0) {
            lines.push('**Repository Entry Points**');
            rec.firstFiles.forEach(f => lines.push(`- ${f}`));
            lines.push('');
        }

        if (rec.learningPath && rec.learningPath.length > 0) {
            lines.push('**Suggested Reading Order**');
            rec.learningPath.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
            lines.push('');
        }

        return lines.join('\n');
    }

    private renderRefactoringInsights(rec: RefactoringRecommendation, factors: string[]): string {
        if (!this.hasSubstantiveContent([rec.hotspots, rec.largeModules, rec.warnings], factors)) {
            return '';
        }

        const lines: string[] = [];
        lines.push('\n\n### Refactoring Opportunities\n');
        
        const cleanFactors = this.cleanReasoningFactors(factors);
        if (cleanFactors.length > 0) {
            cleanFactors.forEach(f => lines.push(`${f}\n`));
        }

        if (rec.hotspots && rec.hotspots.length > 0) {
            lines.push('**Architectural Hotspots**');
            rec.hotspots.forEach(h => lines.push(`- ${h}`));
            lines.push('');
        }

        if (rec.largeModules && rec.largeModules.length > 0) {
            lines.push('**Large Modules**');
            rec.largeModules.forEach(m => lines.push(`- ${m}`));
            lines.push('');
        }

        if (rec.warnings && rec.warnings.length > 0) {
            lines.push('**Dependency Risks**');
            rec.warnings.forEach(w => lines.push(`- ${w}`));
            lines.push('');
        }

        return lines.join('\n');
    }
}
