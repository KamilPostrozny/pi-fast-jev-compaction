import test from "node:test";
import assert from "node:assert/strict";
import {
  isStatusDocument, statusDocumentExcerpt, MAX_TASK_EXCERPT_CHARS,
} from "../extensions/task-excerpts.ts";

const history = `## Completed implementation\n${"irrelevant implementation details ".repeat(300)}\n\n`;
const warning = "- The keep-mine outbox race was reproduced on the base commit.\n  Not a regression; out of scope for this task.";

test("status recognition is limited to Markdown status/handoff/progress filenames", () => {
  for (const path of ["docs/increment-3-status.md", "STATUS.md", "task_progress.markdown", "C:\\repo\\handoff.md"]) {
    assert.equal(isStatusDocument(path), true, path);
  }
  for (const path of ["src/status.ts", "docs/status/api.md", "docs/statuscode.md", "README.md", "AGENTS.md", "plan.md", "notes.txt"]) {
    assert.equal(isStatusDocument(path), false, path);
  }
});

test("constraints and next task survive without preserving implementation history", () => {
  const text = `# Increment status\n\n## Next task\n\nImplement duty actions.\n\n${history}## Constraints and open edges\n\n${warning}\n`;
  const excerpt = statusDocumentExcerpt("docs/increment-3-status.md", text)!;
  assert.ok(excerpt.length <= MAX_TASK_EXCERPT_CHARS);
  assert.match(excerpt, /historical task notes/);
  assert.match(excerpt, /not current file contents/);
  assert.ok(excerpt.includes(warning));
  assert.match(excerpt, /Implement duty actions/);
  assert.doesNotMatch(excerpt, /irrelevant implementation details/);
});

test("known issues outrank long status/history sections and keep complete qualifications", () => {
  const text = `## Validation\n\n${"Test suite green. ".repeat(180)}\n\n## Known issues\n\n${warning}\n\n${history}`;
  const excerpt = statusDocumentExcerpt("status.md", text, 400)!;
  assert.ok(excerpt.length <= 400);
  assert.ok(excerpt.includes(warning));
  assert.doesNotMatch(excerpt, /Test suite green/);
});

test("long paragraphs/tables are skipped, never cut in the middle", () => {
  const longBlock = `- ${"Long explanation ".repeat(200)}\n  This is NOT a regression.`;
  const text = `## Constraints\n\n${longBlock}\n\n${warning}\n\n${history}`;
  const excerpt = statusDocumentExcerpt("status.md", text, 400)!;
  assert.ok(excerpt.includes(warning));
  assert.doesNotMatch(excerpt, /Long explanation/);
});

test("fenced code and fake headings inside fences cannot become retained notes", () => {
  const text = "```md\n## Known issues\nFAKE WARNING\n```\n\n## Constraints\n\n" + warning +
    "\n\n```ts\nSOURCE CODE\n```\n\n" + history;
  const excerpt = statusDocumentExcerpt("status.md", text)!;
  assert.ok(excerpt.includes(warning));
  assert.doesNotMatch(excerpt, /FAKE WARNING|SOURCE CODE/);
});

test("small relevant documents are not enlarged by the excerpt marker", () => {
  const text = `## Known issues\n\n${warning}`;
  assert.equal(statusDocumentExcerpt("status.md", text), text);
});

test("ordinary source/README reads, missing headings, and insufficient budgets produce no excerpt", () => {
  for (const path of ["api.ts", "README.md"]) {
    assert.equal(statusDocumentExcerpt(path, `## Known issues\n${warning}`), undefined);
  }
  assert.equal(statusDocumentExcerpt("status.md", "An unstructured note."), undefined);
  assert.equal(statusDocumentExcerpt("status.md", `${history}## Known issues\n${warning}`, 100), undefined);
  assert.equal(statusDocumentExcerpt("status.md", `${history}## Known issues\n${warning}`, NaN), undefined);
});
