import type { BusFrame } from "./format.mjs";
export interface BusDelivery { id: string; handle: string; body: string }
export interface BusTransport {
  provider: string;
  publish(queueUrl: string, frames: BusFrame[]): Promise<void>;
  receive(queueUrl: string, signal?: AbortSignal): Promise<BusDelivery[]>;
  acknowledge(queueUrl: string, messages: BusDelivery[]): Promise<void>;
}
export function createBusTransport(configuration: any, fetcher?: typeof fetch): BusTransport;
