import type { Account } from "../config.js";
import type { Attachments, Comments, Get, Search, Mentions } from "./inputs.js";
import type { Attachment, CandidatePage, Comment, DownloadReceipt, Page, ReadResult, Ticket, User } from "./ticket.js";

export interface TicketProvider {
  readonly capabilities: { search: boolean; adf: boolean; serviceManagement: boolean; download: boolean; mentionCandidates: boolean; remoteWrites: boolean };
  tenant?(account: Account, signal: AbortSignal): Promise<void>;
  serviceManagementStatus?(account: Account, signal: AbortSignal): Promise<"reachable" | "denied" | "not-tested">;
  identity(account: Account, signal: AbortSignal): Promise<User>;
  get(account: Account, input: Get, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Ticket>>;
  search(account: Account, input: Search, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Ticket>>>;
  mentionCandidates(account: Account, input: Mentions, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<CandidatePage>>;
  attachmentMetadata(account: Account, attachment: Attachment, signal: AbortSignal): Promise<void>;
  comments(account: Account, input: Comments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Comment>>>;
  attachments(account: Account, input: Attachments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Attachment>>>;
  download(account: Account, ticket: Ticket, attachment: Attachment, signal: AbortSignal, consume: BinaryConsumer): Promise<DownloadReceipt>;
  close(): void;
}
export type ReadAccess = (issueKey: string, projectKey?: string) => Promise<void>;
export type BinaryConsumer = (response: Response, signal: AbortSignal) => Promise<Pick<DownloadReceipt, "path" | "size" | "sha256">>;
