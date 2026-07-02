import { MemoryValueRepository } from "./memoryValueRepository";
import { DormancyService } from "./dormancyService";

export class BudgetEnforcementService {
    private readonly MAX_ACTIVE_MEMORIES = 5000;

    constructor(
        private readonly valueRepository: MemoryValueRepository,
        private readonly dormancyService: DormancyService
    ) {}

    public async enforceBudget(repositoryId: string): Promise<void> {
        const activeMemories = await this.valueRepository.getAllActiveMetadata(repositoryId);

        if (activeMemories.length <= this.MAX_ACTIVE_MEMORIES) {
            return;
        }

        // We are over budget. Find the lowest ValueScore memory.
        let lowestMemory = activeMemories[0];
        for (const memory of activeMemories) {
            if (memory.valueScore < lowestMemory.valueScore) {
                lowestMemory = memory;
            }
        }

        // Transition it to dormant
        if (lowestMemory) {
            await this.dormancyService.transitionToDormant(
                lowestMemory.memoryId, 
                "Budget enforcement pruned lowest-value memory"
            );
        }
    }
}
