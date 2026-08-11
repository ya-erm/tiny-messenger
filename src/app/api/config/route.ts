import { API_VERSION, LIMITS } from "@/lib/constants";
import { ok, route } from "@/lib/api";
import { assertRateLimit } from "@/lib/rate-limit";
import { animalNames } from "@/lib/names";

export const GET = route(async (request) => {
  assertRateLimit(request);
  return ok({ apiVersion: API_VERSION, limits: LIMITS, suggestedNames: animalNames });
});
