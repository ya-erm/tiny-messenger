import { createHash, randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { createToken, hashToken, publicUser } from "@/lib/auth";
import { recordNicknameClaim } from "@/lib/replication/users";
import { LIMITS } from "@/lib/constants";
import { write } from "@/lib/db";
import { animalProfileByName, randomAnimalProfile } from "@/lib/names";
import { assertRateLimit } from "@/lib/rate-limit";
import { toUserRecord } from "@/lib/store";
import { cleanNickname, cleanString, isUuid, validLength, validNickname } from "@/lib/validation";

export const POST = route(async (request) => {
  assertRateLimit(request);
  const body = await readJson(request);
  const suppliedName = cleanString(body.name);
  const animalProfile = suppliedName ? animalProfileByName(suppliedName) : randomAnimalProfile();
  const name = suppliedName || animalProfile?.name || randomAnimalProfile().name;
  const nickname = cleanNickname(body.nickname);
  if (!validLength(name, 1, LIMITS.name)) {
    throw new ApiError(422, "invalid_name", `Имя должно быть не длиннее ${LIMITS.name} символов`);
  }
  if (nickname && !validNickname(nickname)) {
    throw new ApiError(
      422,
      "invalid_nickname",
      `Ник: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
    );
  }

  const stable = body.clientRequestId !== undefined || body.registrationToken !== undefined;
  if(stable&&(!isUuid(body.clientRequestId)||typeof body.registrationToken!=="string"||!/^msg_[A-Za-z0-9_-]{16}$/.test(body.registrationToken)))throw new ApiError(422,"invalid_registration_request","Некорректный идентификатор регистрации");
  const id=stable?String(body.clientRequestId).toLowerCase():randomUUID();
  const token = stable?String(body.registrationToken):createToken();
  const fingerprint=createHash("sha256").update(JSON.stringify({name:suppliedName,nickname,tokenHash:hashToken(token)})).digest("hex");
  let replayed=false;
  const now = new Date().toISOString();
  const user = await write(async (tx) => {
    if(stable){
      const receipt=await tx.replicationState.findUnique({where:{key:"registration:"+id}}),known=await tx.user.findUnique({where:{id}});
      if(receipt||known){
        if(receipt?JSON.parse(receipt.body).hash!==fingerprint:known?.tokenHash!==hashToken(token))throw new ApiError(409,"registration_conflict","ID регистрации уже использован");
        if(!known||known.tokenHash!==hashToken(token))throw new ApiError(409,"registration_conflict","Регистрация недоступна");replayed=true;return known;
      }
    }
    if(await tx.user.findUnique({where:{tokenHash:hashToken(token)}}))throw new ApiError(409,"registration_conflict","Токен уже используется");
    if (nickname && await tx.user.findUnique({ where: { nickname }, select: { id: true } })) {
      throw new ApiError(409, "nickname_taken", "Этот ник уже занят");
    }
    const created=await tx.user.create({
      data: {
        id,
        name,
        nickname: nickname || null,
        avatarUrl: animalProfile?.avatarUrl || null,
        tokenHash: hashToken(token),
        createdAt: now,
        updatedAt: now,
      },
    });
    await recordNicknameClaim(tx,id,nickname||null,now);
    if(stable)await tx.replicationState.create({data:{key:"registration:"+id,body:JSON.stringify({hash:fingerprint})}});
    return created;
  });

  return ok({ user: publicUser(toUserRecord(user)), token }, { status: replayed?200:201 });
});
