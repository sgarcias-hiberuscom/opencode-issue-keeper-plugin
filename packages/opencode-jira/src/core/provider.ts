import type { Account } from "../config.js";
import type { Attachments, Comments, Get, Search } from "../tools/schemas.js";
import type { Attachment, Comment, Page, ReadResult, Ticket, User } from "./ticket.js";

export interface TicketProvider {
  identity(account: Account, signal: AbortSignal): Promise<User>;
  get(account: Account, input: Get, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Ticket>>;
  search(account: Account, input: Search, signal: AbortSignal): Promise<ReadResult<Page<Ticket>>>;
  comments(account: Account, input: Comments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Comment>>>;
  attachments(account: Account, input: Attachments, signal: AbortSignal, authorize?: ReadAccess): Promise<ReadResult<Page<Attachment>>>;
  download<T>(account: Account, ticket: Ticket, attachment: Attachment, signal: AbortSignal, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): void;
}
export type ReadAccess = (issueKey: string) => Promise<void>;
