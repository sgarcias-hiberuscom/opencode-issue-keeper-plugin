export interface Ref { account: string; issueKey: string }
export interface Pagination { cursor?: string; maxResults?: number }
export interface Get extends Ref { fields?: string[] }
export interface Search extends Pagination { account: string; jql: string; fields?: string[] }
export type Audience = "ticket" | "internal" | "public";
export interface Visibility { type: "role" | "group"; value: string }
export interface Comments extends Ref, Pagination { audience?: Audience }
export interface Attachments extends Ref, Pagination {}
export interface Download extends Ref { attachmentId: string; destinationName?: string }
export interface Mentions extends Ref, Pagination {
  audience: Audience;
  visibility?: Visibility;
  query?: string;
  accountId?: string;
}
