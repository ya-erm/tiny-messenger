import { ok, route } from "@/lib/api";
export const GET = route(async () => ok({ installationId: process.env.TM_INSTALLATION_ID || "vps-1", protocolVersion: 1,
  mutationTypes: ["message.create", "message.edit", "message.delete", "reaction.set"],
  capabilities: ["personal-text", "edits", "reactions", "deletions", "native-token"], files: true, voice: true, replication: Boolean(process.env.TM_REPLICATION_CONFIG) }));
