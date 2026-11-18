import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schemas from "../../src/tools/change-schemas.js";

const ref = { account: "qa", issueKey: "ik-1", expectedUpdated: "2026-11-17T10:00:00Z" };
describe("[CON-01][PR-01/03/07][AT-06][UP-08] strict unregistered change schemas", () => {
  it("only accepts a proposal ID for application, without caller approval or context overrides", () => {
    expect(schemas.parseChangeArguments(schemas.ApplyInput, { proposalId: "proposal-1" })).toEqual({ proposalId: "proposal-1" });
    for (const [key, value] of Object.entries({ account: "other", confirmed: true, payload: {}, sessionID: "forged", locationID: "forged", scope: {}, approval: true })) {
      expect(() => schemas.parseChangeArguments(schemas.ApplyInput, { proposalId: "proposal-1", [key]: value })).toThrow();
    }
  });
  it("requires a real date for every preparation and normalizes only the issue key", () => {
    expect(schemas.parseChangeArguments(schemas.UpdatePrepareInput, { ...ref, fields: { summary: "nuevo" } })).toMatchObject({ issueKey: "IK-1" });
    for (const schema of [schemas.UpdatePrepareInput, schemas.CommentPrepareInput, schemas.UploadPrepareInput, schemas.TransitionPrepareInput]) expect(() => schemas.parseChangeArguments(schema, { account: "qa", issueKey: "IK-1" })).toThrow();
  });
  it.each(["2026-02-31T10:00:00Z", "2026-11-17T24:00:00Z", "2026-13-01T10:00:00Z"])("does not accept an invented calendar timestamp %s", (expectedUpdated) => {
    expect(() => schemas.parseChangeArguments(schemas.UpdatePrepareInput, { ...ref, expectedUpdated, fields: { summary: "x" } })).toThrow();
  });
  it("rejects empty/duplicated fields and embedded capabilities without stripping them", () => {
    for (const edit of [{}, { fields: {} }, { fields: { status: "done" } }, { update: { comment: [{ add: "hidden" }] } }, { fields: { summary: "a" }, update: { summary: [{ set: "b" }] } }]) expect(() => schemas.parseChangeArguments(schemas.UpdatePrepareInput, { ...ref, ...edit })).toThrow();
  });
  it("defaults comment format to plain while keeping text symbols exact and audience mandatory", () => {
    const text = "😀 **literal**\r\ntexto";
    expect(schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text, audience: "ticket" })).toMatchObject({ text, format: "plain" });
    expect(() => schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text })).toThrow();
    expect(() => schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text, audience: "internal", visibility: { type: "role", value: "Team" } })).toThrow();
  });
  it("reports invalid format and text complexity without echoing input", () => {
    for (const extra of [{ format: "private-marker" }, { text: "x".repeat(100001) }]) {
      try { schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text: "x", audience: "ticket", ...extra }); throw new Error("accepted"); }
      catch (error) { expect(error).toMatchObject({ code: "FORMAT_INVALID", retryable: false }); expect(String(error)).not.toContain("private-marker"); }
    }
  });
  it.each([[0, 1], [1, 2], [3, 3], [0, 100]])("rejects invalid/split UTF-16 mention range %i..%i", (start, end) => {
    expect(() => schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text: "😀 Persona", audience: "ticket", mentions: [{ accountId: "person", start, end }] })).toThrow();
  });
  it("rejects overlapping mentions without changing their order or source", () => {
    expect(() => schemas.parseChangeArguments(schemas.CommentPrepareInput, { ...ref, text: "Persona", audience: "ticket", mentions: [{ accountId: "a", start: 0, end: 4 }, { accountId: "b", start: 3, end: 7 }] })).toThrow();
  });
  it("never defaults an upload to public or accepts temporary IDs/base64/URLs", () => {
    const files = [{ path: "exports/file.txt" }];
    expect(() => schemas.parseChangeArguments(schemas.UploadPrepareInput, { ...ref, files })).toThrow();
    for (const extra of [{ format: "plain" }, { mentions: [] }, { temporaryAttachmentIds: ["temp"] }, { comment: "implicit Platform comment" }]) expect(() => schemas.parseChangeArguments(schemas.UploadPrepareInput, { ...ref, files, audience: "ticket", ...extra })).toThrow();
    expect(() => schemas.parseChangeArguments(schemas.UploadPrepareInput, { ...ref, files: [{ path: "https://evil.invalid" }], audience: "public" })).toThrow();
  });
  it("rejects non-JSON, getters and oversized documents before recursive tool validation", () => {
    let invoked = false; const getter = Object.defineProperty({}, "proposalId", { enumerable: true, get() { invoked = true; return "p"; } });
    expect(() => schemas.parseChangeArguments(schemas.ApplyInput, getter)).toThrow(); expect(invoked).toBe(false);
    expect(() => schemas.parseChangeArguments(schemas.UpdatePrepareInput, { ...ref, fields: { summary: "x".repeat(1024 * 1024) } })).toThrow();
  });
  it("can publish strict JSON schemas later without registering partial write tools", () => {
    for (const schema of [schemas.EditMetadataInput, schemas.TransitionsInput, schemas.UpdatePrepareInput, schemas.CommentPrepareInput, schemas.UploadPrepareInput, schemas.TransitionPrepareInput, schemas.ApplyInput]) {
      expect(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }).additionalProperties).toBe(false);
    }
  });
});
