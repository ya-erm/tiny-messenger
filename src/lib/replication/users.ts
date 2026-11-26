import type { Prisma } from "@/generated/prisma/client";
import { parseReplicatedUser, nicknameClaimOrder, type ReplicatedUser } from "./users-protocol";
const claimKey = (id: string) => "nickname-claim:" + id;
export async function recordNicknameClaim(tx: Prisma.TransactionClient, id: string, nickname: string | null, at: string) {
  const body=JSON.stringify({nickname,at});
  await tx.replicationState.upsert({where:{key:claimKey(id)},create:{key:claimKey(id),body},update:{body}});
}
export async function importNewPeerUser(tx: Prisma.TransactionClient, input: unknown) {
  const user=parseReplicatedUser(input);
  const known=await tx.user.findUnique({where:{id:user.id}});
  // A birth snapshot cannot overwrite a known account. Versioned identity
  // events handle subsequent edits; late registration cannot restore a key.
  if(known)return known;
  let nickname=user.nickname||null;
  if(nickname){
    const owner=await tx.user.findUnique({where:{nickname}});
    if(owner){
      const saved=await tx.replicationState.findUnique({where:{key:claimKey(owner.id)}});
      const claim=saved?JSON.parse(saved.body):undefined;
      const at=claim?.nickname===nickname?claim.at:owner.createdAt;
      if(nicknameClaimOrder(user.createdAt,user.id)<nicknameClaimOrder(at,owner.id))await tx.user.update({where:{id:owner.id},data:{nickname:null}});
      else nickname=null;
    }
  }
  const created=await tx.user.create({data:{...user,nickname,avatarUrl:user.avatarUrl||null,avatarBackground:user.avatarBackground||null}});
  await recordNicknameClaim(tx,user.id,nickname,user.createdAt);
  return created;
}
