// These are small historical excerpts inside existing tool results, not pinned
// source reads, synthetic user instructions, or a second summarizer.
export const MAX_TASK_EXCERPT_CHARS = 2_400;
export const MAX_TASK_EXCERPTS_TOTAL_CHARS = 7_200;

export function isStatusDocument(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /^(.*)\.(?:md|markdown)$/i.exec(name);
  return Boolean(match && /(?:^|[-_. ])(?:status|handoff|progress)(?:[-_. ]|$)/i.test(match[1]!));
}

function sectionPriority(title: string): number | null {
  const normalized = title.toLowerCase().replace(/[*_`]/g, "");
  if (/\b(?:constraints?|known (?:issues?|failures?|exceptions?|limitations?)|open (?:edges|issues)|blockers?|validation exceptions?|pre-existing)\b/.test(normalized)) return 0;
  if (/\b(?:next task|current task|active task|next steps|in progress)\b/.test(normalized)) return 1;
  if (/\b(?:task state|task status|validation|verification|progress)\b/.test(normalized)) return 2;
  return null;
}

/** Extract whole Markdown blocks; never cut a qualification or negation mid-line. */
export function statusDocumentExcerpt(
  path: string,
  text: string,
  budget = MAX_TASK_EXCERPT_CHARS,
): string | undefined {
  if (!isStatusDocument(path)) return undefined;
  const limit = Math.min(MAX_TASK_EXCERPT_CHARS, Math.max(0, Math.floor(budget)));
  if (!Number.isFinite(limit)) return undefined;
  const sections: Array<{ title: string; level: number; priority: number; lines: string[] }> = [];
  let current: (typeof sections)[number] | undefined;
  let fence: { char: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.length && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      // Keep a block boundary, but do not retain code or headings inside fences.
      current?.lines.push("");
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const priority = sectionPriority(heading[2]!);
      if (current && level > current.level) {
        current.lines.push(line);
      } else {
        current = undefined;
        if (priority !== null) {
          current = { title: line.trim(), level, priority, lines: [] };
          sections.push(current);
        }
      }
    } else {
      current?.lines.push(line);
    }
  }

  const intro = "[fast-jev-compaction: result pruned; selected historical task notes below, not current file contents. Omitted sections may matter; re-read the status document before updating it.]";
  const selected: string[] = [];
  let used = intro.length;
  for (const section of sections.sort((a, b) => a.priority - b.priority)) {
    // Blank lines and top-level bullets separate blocks. A multiline bullet
    // keeps its continuation ('not a regression', 'out of scope', etc.). Large
    // tables/paragraphs are skipped whole, not cut into misleading fragments.
    const blocks = section.lines.join("\n").trim()
      .split(/\n\s*\n|\n(?=(?:[-*+]|\d+[.)])\s)/).filter(Boolean);
    const kept: string[] = [];
    for (const block of blocks) {
      const overhead = kept.length ? 2 : 2 + section.title.length + 2;
      if (used + overhead + block.length > limit) continue;
      kept.push(block);
      used += overhead + block.length;
    }
    if (kept.length) selected.push(`${section.title}\n\n${kept.join("\n\n")}`);
  }
  if (selected.length === 0) return undefined;
  const excerpt = `${intro}\n\n${selected.join("\n\n")}`;
  // A small, relevant status document need not grow just to label its excerpt.
  return text.length <= excerpt.length ? text : excerpt;
}
