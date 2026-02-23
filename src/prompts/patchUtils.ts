import type { PromptPatch } from '../evolution/types.js';

/**
 * Apply an ordered list of patches to a base prompt template.
 * Returns the patched result, or the original base if any patch fails.
 */
export function applyPatches(base: string, patches: PromptPatch[]): string {
  let result = base;
  for (const patch of patches) {
    try {
      result = applySinglePatch(result, patch);
    } catch {
      // If any single patch fails, return the unmodified base
      return base;
    }
  }
  return result;
}

function applySinglePatch(text: string, patch: PromptPatch): string {
  switch (patch.op) {
    case 'prepend':
      return patch.content + '\n' + text;

    case 'append':
      return text + '\n' + patch.content;

    case 'replace_section': {
      if (!patch.section) throw new Error('replace_section requires a section name');
      const { start, end } = findSectionBounds(text, patch.section);
      if (start === -1) throw new Error(`Section not found: ${patch.section}`);
      const before = text.slice(0, start);
      const after = text.slice(end);
      const nlIdx = text.indexOf('\n', start);
      const heading = nlIdx === -1 ? text.slice(start) + '\n' : text.slice(start, nlIdx + 1);
      return before + heading + patch.content + '\n' + after;
    }

    case 'remove_section': {
      if (!patch.section) throw new Error('remove_section requires a section name');
      const { start, end } = findSectionBounds(text, patch.section);
      if (start === -1) throw new Error(`Section not found: ${patch.section}`);
      return text.slice(0, start) + text.slice(end);
    }

    default:
      throw new Error(`Unknown patch op: ${(patch as { op: string }).op}`);
  }
}

/**
 * Find the byte range of a markdown section (## heading + body).
 * Returns { start: line start of heading, end: start of next same-or-higher heading or EOF }.
 */
function findSectionBounds(text: string, sectionName: string): { start: number; end: number } {
  const lines = text.split('\n');
  let start = -1;
  let headingLevel = 0;
  let charOffset = 0;
  let startOffset = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.*)$/);

    if (match) {
      const level = match[1].length;
      const title = match[2].trim();

      if (start === -1 && title === sectionName) {
        start = i;
        headingLevel = level;
        startOffset = charOffset;
      } else if (start !== -1 && level <= headingLevel) {
        return { start: startOffset, end: charOffset };
      }
    }

    charOffset += line.length + 1; // +1 for \n
  }

  if (start !== -1) {
    return { start: startOffset, end: text.length };
  }

  return { start: -1, end: -1 };
}

/**
 * Validate that a patched prompt still contains expected JSON output format markers.
 * Returns true if the prompt appears safe to use.
 */
export function validatePatchedPrompt(patchedPrompt: string, promptName: string): boolean {
  // Only prompts with structured JSON output need validation
  const markersByPrompt: Record<string, string[]> = {
    scan: ['"issues"', '"projectHealth"'],
    plan: ['"tasks"', '"reasoning"'],
    reflect: ['"experiences"', '"taskSummary"'],
    reviewer: ['"passed"', '"issues"', '"summary"'],
    executor: [],       // no JSON output format
    brain_system: [],   // no JSON output format
    research: [],       // free-form markdown output
    plan_markdown: ['"tasks"', '"reasoning"', '"markdown"'],
    analysis: ['"title"', '"modules"', '"markdown"'],
    evaluator: ['"problemLegitimacy"', '"reasoning"'],
  };

  const markers = markersByPrompt[promptName] ?? [];
  for (const marker of markers) {
    if (!patchedPrompt.includes(marker)) {
      return false;
    }
  }

  return true;
}
