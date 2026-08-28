import { notFound } from "next/navigation";
import { MessengerApp } from "@/components/messenger-app";
import { isUuid } from "@/lib/validation";

type SharedProfileByIdPageProps = {
  params: Promise<{ userId: string }>;
};

export default async function SharedProfileByIdPage({ params }: SharedProfileByIdPageProps) {
  const { userId: pathSegment } = await params;
  const userId = pathSegment.toLowerCase();

  if (!isUuid(userId)) {
    notFound();
  }

  const shortUserId = `${userId.slice(0, 8)}…${userId.slice(-4)}`;
  return <MessengerApp sharedIdentifier={userId} sharedLabel={`UUID ${shortUserId}`} />;
}
