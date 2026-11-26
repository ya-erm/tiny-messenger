export interface BusTarget { installationId: string; address: string; direct?: { url: string; secret: string } }
export function publishToTarget(transport: { publish(address: string, frames: any[]): Promise<unknown> }, target: BusTarget, frames: any[], fetcher?: typeof fetch): Promise<{ route: "direct" | "broker" | "none" }>;
