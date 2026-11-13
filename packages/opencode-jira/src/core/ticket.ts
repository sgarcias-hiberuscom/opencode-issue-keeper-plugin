export interface User { id: string; displayName?: string }
export interface Ticket {
  provider: "jira-cloud";
  account: string;
  id: string;
  key: string;
  url: string;
  project: { id: string; key: string };
  summary: string;
  descriptionText?: string;
  status: { id?: string; name: string };
  assignee?: User | null;
  reporter?: User;
  labels?: string[];
  updated?: string;
  fetchedAt: string;
  source: "platform" | "jsm-request";
  serviceRequest?: { serviceDeskId: string; requestTypeId: string };
  customFields?: Record<string, unknown>;
}
export interface Comment {
  id: string;
  text: string;
  audience: "ticket" | "internal" | "public";
  author?: User;
  created?: string;
  visibility?: { type: string; value: string };
}
export interface Attachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  audience: "unknown" | "ticket" | "internal" | "public";
}
export interface Page<T> { values: T[]; isLast: boolean; cursor?: string }
export interface ReadResult<T> { data: T; warnings: string[] }
export interface DownloadReceipt {
  path: string;
  size: number;
  sha256: string;
  account: string;
  issueKey: string;
  attachmentId: string;
  audience: Attachment["audience"];
  location: "server";
}
