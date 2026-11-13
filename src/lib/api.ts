import { JSON_BODY_LIMIT } from "@/lib/constants";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const size = Number(request.headers.get("content-length") || 0);
  if (size > JSON_BODY_LIMIT) {
    throw new ApiError(413, "payload_too_large", "Тело запроса слишком большое");
  }
  try {
    // Content-Length may be absent (chunked requests). Bound actual bytes too,
    // especially now that messages no longer have the tiny character limit.
    const reader = request.body?.getReader();
    if (!reader) throw new Error("empty body");
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > JSON_BODY_LIMIT) {
          await reader.cancel().catch(() => {});
          throw new ApiError(413, "payload_too_large", "Тело запроса слишком большое");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Ожидался JSON-объект");
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json(
    { ok: true, data },
    {
      ...init,
      headers: { "Cache-Control": "no-store", ...init?.headers },
    },
  );
}

export function route(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response>;
export function route<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response>;
export function route<Context>(
  handler: (request: Request, context?: Context) => Promise<Response>,
) {
  return async (request: Request, context?: Context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json(
          {
            ok: false,
            error: { code: error.code, message: error.message, details: error.details },
          },
          {
            status: error.status,
            headers: {
              "Cache-Control": "no-store",
              ...(error.status === 429 && error.details?.retryAfterSeconds
                ? { "Retry-After": String(error.details.retryAfterSeconds) }
                : {}),
            },
          },
        );
      }
      console.error(error);
      return Response.json(
        { ok: false, error: { code: "internal_error", message: "Внутренняя ошибка сервера" } },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}
