export interface MemoryValueInputs {
    confidence: number;
    usageFrequency: number;
    impactScore: number;
    recencyScore: number;
    humanWeight: number;
}

export function calculateValueScore(inputs: MemoryValueInputs): number {
    const rawScore = 
        (inputs.confidence * 0.2) +
        (inputs.usageFrequency * 0.3) +
        (inputs.impactScore * 0.2) +
        (inputs.recencyScore * 0.1) +
        (inputs.humanWeight * 0.5);

    return Math.max(0.0, Math.min(1.0, rawScore));
}
