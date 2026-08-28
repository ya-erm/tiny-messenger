import { LIMITS } from "@/lib/constants";
import type { MessageKind } from "@/lib/types";

export function characterCount(value: string) {
  return Array.from(value).length;
}

export function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function cleanNickname(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function validLength(value: string, min: number, max: number) {
  const length = characterCount(value);
  return length >= min && length <= max;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function validNickname(value: string) {
  return validLength(value, 1, LIMITS.nickname) && /^[a-z0-9_.-]+$/.test(value);
}

export function isMessageKind(value: unknown): value is MessageKind {
  return value === "text" || value === "choice";
}

export function validToken(value: string) {
  return (
    validLength(value, LIMITS.tokenMin, LIMITS.tokenMax) &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

export function validHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
