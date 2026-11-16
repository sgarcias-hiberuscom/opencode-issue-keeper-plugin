export interface User { id: string; displayName?: string }
export interface TicketRef { provider: "jira-cloud"; account: string; id: string; key: string; url: string }
export interface Mention { accountId: string; label: string }
interface TicketBase extends TicketRef {
  project: { id: string; key: string; projectTypeKey?: string };
  summary: string;
  descriptionText?: string;
  mentions?: Mention[];
  assignee?: User | null;
  reporter?: User;
  labels?: string[];
  fetchedAt: string;
  serviceRequest?: { serviceDeskId: string; requestTypeId: string };
  customFields?: Record<string, unknown>;
  priority?: { id: string; name: string };
  issuetype?: { id: string; name: string };
}
export type Ticket = TicketBase & (
  { source: "platform"; updated: string; status: { id: string; name: string } }
  | { source: "jsm-request"; updated?: never; status: { name: string; id?: never } }
);
export interface Comment {
  id: string;
  text: string;
  audience: "ticket" | "internal" | "public";
  author?: User;
  created?: string;
  visibility?: { type: string; value: string };
  mentions?: Mention[];
}
export interface Attachment {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  audience: "unknown" | "ticket" | "internal" | "public";
  author?: User;
  created?: string;
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
  site: string;
  via: "platform" | "jsm";
  filename: string;
  mimeType: string;
}
export interface Candidate {
  accountId: string; displayName?: string;
  origins: ("platform" | "reporter" | "participant")[];
  validation: "validated" | "unverified";
  reason?: string;
}
export interface CandidatePage extends Page<Candidate> {
  account: string; issueKey: string; audience: "ticket" | "internal" | "public";
  visibility?: { type: "role" | "group"; value: string };
  ambiguous: boolean;
}
