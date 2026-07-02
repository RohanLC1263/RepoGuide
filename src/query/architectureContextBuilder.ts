import {
    ArchitectureContext,
    ClassifiedIntent
} from '../comprehension/types';
import { ComprehensionEngine } from '../comprehension/comprehensionEngine';

export class ArchitectureContextBuilder {
    constructor(private comprehensionEngine: ComprehensionEngine) {}

    buildContext(intent: ClassifiedIntent): ArchitectureContext | null {
        const projectUnderstanding = this.comprehensionEngine.getProjectUnderstanding();
        if (!projectUnderstanding) {
            return null;
        }

        const allModules = this.comprehensionEngine.getAllModuleUnderstandings();
        const relevantModules = intent.concepts.length > 0
            ? allModules.filter(module =>
                intent.concepts.some(concept =>
                    module.keyConcepts.some(keyConcept => keyConcept.toLowerCase().includes(concept.toLowerCase()))
                    || module.modulePath.toLowerCase().includes(concept.toLowerCase())
                    || module.modulePurpose.toLowerCase().includes(concept.toLowerCase())
                )
            )
            : allModules;

        return {
            relevantModules: relevantModules.length > 0 ? relevantModules : allModules.slice(0, 6),
            projectPurpose: projectUnderstanding.purpose,
            architectureType: projectUnderstanding.architecture_type,
            dataFlow: projectUnderstanding.data_flow,
            techStack: projectUnderstanding.tech_stack
        };
    }

    formatForPrompt(context: ArchitectureContext): string {
        const lines: string[] = [];
        lines.push('MODULE OVERVIEW:');
        for (const module of context.relevantModules.slice(0, 8)) {
            lines.push(`${module.modulePath}: ${module.modulePurpose}`);
            if (module.keyConcepts.length > 0) {
                lines.push(`  Key concepts: ${module.keyConcepts.slice(0, 5).join(', ')}`);
            }
            const extDeps = module.externalDependencies.map(d => d.module);
            if (extDeps.length > 0) {
                lines.push(`  Dependencies: ${extDeps.slice(0, 4).join(', ')}`);
            }
        }
        lines.push('');
        lines.push('PROJECT DATA FLOW:');
        lines.push(context.dataFlow);
        if (Object.keys(context.techStack).length > 0) {
            lines.push('');
            lines.push('TECH STACK:');
            for (const [layer, tech] of Object.entries(context.techStack)) {
                const techStr = Array.isArray(tech) ? tech.join(', ') : tech;
                lines.push(`  ${layer}: ${techStr}`);
            }
        }
        return lines.join('\n');
    }
}
