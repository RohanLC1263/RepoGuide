import { EvaluationResult } from '../evaluationModels';

export interface DashboardRenderer {
    readonly format: string;
    render(result: EvaluationResult): string | Promise<string>;
}
