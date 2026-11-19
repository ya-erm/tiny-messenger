import { ok } from "@/lib/api";
export const dynamic = "force-dynamic";
export async function GET() {
  return ok({ version: process.env.NEXT_PUBLIC_APP_VERSION });
}
