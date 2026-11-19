import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { acceptMutation } from "@/lib/mutations/accept";
import { MutationValidationError, parseMutation, type Mutation } from "@/lib/mutations/protocol";
import { assertMessageRateLimit, assertRateLimit } from "@/lib/rate-limit";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const actor = await authenticate(request);
  const body = await readJson(request);
  let operation: Mutation;
  try { operation = parseMutation(body); }
  catch (error) {
    if (error instanceof MutationValidationError) throw new ApiError(422, "invalid_mutation", error.message);
    throw error;
  }
  if (operation.type === "message.create") assertMessageRateLimit(request, actor.id);
  const receipt = await write((tx) => acceptMutation(tx, operation, actor));
  return ok(receipt, { status: receipt.status === "pending" ? 202 : receipt.replayed ? 200 : 201 });
});
