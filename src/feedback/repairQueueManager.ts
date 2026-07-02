
export interface RepairItem { type: string; id: string; }
export interface RepairQueueState { pending: RepairItem[]; [key: string]: any; }
export class RepairQueueManager {
    constructor(a?:any, b?:any, c?:any) {}
    async processQueue() {}
}
