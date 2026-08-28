import { notFound } from "next/navigation";
import { MessengerApp } from "@/components/messenger-app";
import { LIMITS } from "@/lib/constants";

type SharedProfilePageProps = {
  params: Promise<{ nickname: string }>;
};

export default async function SharedProfilePage({ params }: SharedProfilePageProps) {
  const { nickname: pathSegment } = await params;
  let decodedPathSegment = "";
  try {
    decodedPathSegment = decodeURIComponent(pathSegment);
  } catch {
    notFound();
  }
  const nickname = decodedPathSegment.startsWith("@") ? decodedPathSegment.slice(1).toLowerCase() : "";

  if (!nickname || nickname.length > LIMITS.nickname || !/^[a-z0-9_.-]+$/.test(nickname)) {
    notFound();
  }

  return <MessengerApp sharedNickname={nickname} />;
}
