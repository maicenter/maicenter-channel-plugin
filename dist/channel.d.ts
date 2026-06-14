export declare function createMaicenterPolling(ctx: any, agentKey: string, config: any): () => void;
export declare function sendReply(agentKey: string, channelId: string, text: string): Promise<any>;
export declare function reportModelCatalog(cfg: any, agentKey: string): Promise<{
    count: number;
    error?: string;
}>;
