export interface BusFrame { version: 1; from: string; to: string; kind: "events" | "ping" | "pong"; id: string; at: string; events: any[]; pending?: boolean }
export interface BusHealth { listenerAt: number; confirmedAt: number; failedAt: number; receivedAt: number }
export const BUS_VERSION: 1;
export const BUS_MAX_BYTES: number;
export const BUS_BATCH: number;
export function parseBusFrame(value: unknown, self: string, peers: string[]): BusFrame;
export function makeBusFrame(from: string, to: string, kind: string, id: string, payload?: Record<string, unknown>): BusFrame;
export function busHealth(): BusHealth;
export function isBusHealthy(now?: number): boolean;
