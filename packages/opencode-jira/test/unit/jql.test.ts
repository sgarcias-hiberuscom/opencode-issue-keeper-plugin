import { describe, expect, it } from "vitest";
import { parseJql, restrictedJql } from "../../src/jira/jql.js";

describe("[5.4][E02][BU-04] bounded JQL", () => {
  it.each([
    "project = IK AND statusCategory != Done",
    '(project in ("IK", "TEST")) AND (status = Open OR status = Closed)',
    'assignee = currentUser() AND summary ~ "ORDER BY \\"quoted\\"" ORDER BY created DESC, key ASC',
    "updated >= startOfDay(-1) AND NOT (status = Done)",
    "created >= -1d",
    '"project" = "IK" ORDER BY updated',
  ])("accepts a provable conjunction: %s", (jql) => {
    expect(parseJql(jql).useful).toBe(true);
    expect(restrictedJql(jql, [])).toBe(jql);
  });
  it.each([
    "assignee = currentUser() OR updated > -1d", "status = Open", "NOT project = IK",
    "project = IK OR assignee = currentUser()", "(project = IK OR updated > -1d) AND status = Open",
  ])("requires a useful top-level conjunction: %s", (jql) => {
    expect(() => restrictedJql(jql, [])).toThrow();
  });
  it.each(["", "ORDER BY key", "project =", "project = =", "project = IK AND", "project IN ()",
    "(project = IK", "project = IK)", 'project = "unterminated', "project = IK; DROP", "project = IK ORDER BY",
    "project = IK ORDER BY key,", "project = IK\nAND status = Open", "project = IK /*x*/",
    "project = IK AND ORDER BY key", "project = IK OR OR project = OTHER",
  ])("rejects malformed or unsupported JQL: %s", (jql) => {
    expect(() => restrictedJql(jql, ["OUT"])).toThrow();
  });
  it("separates ORDER BY only outside strings, functions and parentheses", () => {
    const jql = 'project = IK OR assignee = currentUser() ORDER BY created';
    expect(restrictedJql(jql, ["A", "B"], false)).toBe('(project = IK OR assignee = currentUser()) AND project NOT IN ("A", "B") ORDER BY created');
    expect(parseJql('project = IK AND summary ~ "ORDER BY created"').orderBy).toBe("");
  });
  it("bounds recursion and token count", () => {
    expect(() => parseJql("(".repeat(60) + "project = IK" + ")".repeat(60))).toThrow();
    expect(() => parseJql("project = IK AND ".repeat(1000) + "project = IK")).toThrow();
  });
});
