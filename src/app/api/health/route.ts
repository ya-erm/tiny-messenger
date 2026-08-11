import { API_VERSION } from "@/lib/constants";
import { ok, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async () =>
  ok({ status: "healthy", apiVersion: API_VERSION, time: new Date().toISOString() }),
);
