import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowed = (process.env.TM_ALLOWED_ORIGINS || "https://tm.ya-erm.ru,https://gh.tm.ya-erm.ru,https://vm.tm.ya-erm.ru").split(",");
  const local = process.env.NODE_ENV !== "production" && origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && !allowed.includes(origin) && !local) return NextResponse.json({ ok: false, error: { code: "origin_not_allowed", message: "Источник приложения не разрешён" } }, { status: 403 });
  const response = request.method === "OPTIONS" ? new NextResponse(null, { status: 204 }) : NextResponse.next();
  response.headers.set("X-TM-Installation-Id", process.env.TM_INSTALLATION_ID || "vps-1");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin");
    response.headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-API-Key");
    response.headers.set("Access-Control-Expose-Headers", "X-TM-Installation-Id,Retry-After");
    response.headers.set("Access-Control-Max-Age", "600");
  }
  return response;
}
export const config = { matcher: "/api/:path*" };
