export function signProof(secret: string, kind: string, fields: Record<string, unknown>, ttl?: number, now?: number): string;
export function verifyProof(secret: string, kind: string, token: unknown, now?: number, maxTTL?: number): Record<string, unknown>;
export function identity(value: unknown): string;
export function protocolError(status: number, message: string): Error & {status: number};
