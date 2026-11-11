export interface AttachmentInfo {
  id: string;
  originalName: string;
  size: number;
  contentType: string;
  preview: "image" | "video" | null;
}

export interface AttachmentLimits {
  enabled: boolean;
  maxFileBytes: number;
  maxFilesPerMessage: number;
  maxPending: number;
  userQuotaBytes: number;
}

export function attachmentPreview(type: string): AttachmentInfo["preview"] {
  if (["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(type)) return "image";
  if (["video/mp4", "video/webm", "video/ogg"].includes(type)) return "video";
  return null;
}

export function formatFileSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КиБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МиБ`;
}
