// Shared Ponytail instruction builder for Claude hooks and Pi extension.

const fs = require('fs');
const path = require('path');
const { DEFAULT_MODE, normalizeMode } = require('./ponytail-config');
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'ponytail', 'SKILL.md');

function filterSkillBodyForMode(body, mode) {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;
  const withoutFrontmatter = String(body || '').replace(/^---[\s\S]*?---\s*/, '');

  // Only the intensity table rows and worked examples are mode-specific, and
  // both are keyed by a mode name (lite/full/ultra). A bullet whose label is
  // not a mode — e.g. "No unrequested abstractions: ..." — is a normal rule
  // and must be kept verbatim.
  return withoutFrontmatter
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const labelMode = normalizeMode(tableLabel[1].trim());
        if (labelMode) return labelMode === effectiveMode;
      }

      const exampleLabel = line.match(/^-\s*([^:]+):\s*/);
      if (exampleLabel) {
        const labelMode = normalizeMode(exampleLabel[1].trim());
        if (labelMode) return labelMode === effectiveMode;
      }

      return true;
    })
    .join('\n');
}

function getPonytailInstructions(mode) {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;

  try {
    return 'PONYTAIL MODE ACTIVE — level: ' + effectiveMode + '\n\n' +
      filterSkillBodyForMode(fs.readFileSync(SKILL_PATH, 'utf8'), effectiveMode);
  } catch (e) {
    // ponytail: SKILL.md missing or unreadable — compact inline fallback keeps the ladder and rules.
    return [
      'PONYTAIL MODE ACTIVE — level: ' + effectiveMode,
      '',
      'Persistence: ACTIVE EVERY RESPONSE. No drift back to over-building.',
      'Off only: "stop ponytail" / "normal mode". Default: **full**.',
      '',
      'The ladder (stop at the first rung that holds):',
      '1. Does this need to exist at all? (YAGNI)',
      '2. Already in this codebase? Reuse it.',
      '3. Stdlib does it? Use it.',
      '4. Native platform feature covers it?',
      '5. Already-installed dependency solves it?',
      '6. Can it be one line? One line.',
      '7. Only then: minimum code that works.',
      '',
      'Rules: No speculative abstractions. Deletion over addition. Fewest files.',
      'Mark shortcuts with ponytail: comments. One-line counterfactual: if the complex',
      'version is not a one-liner or 5-line trivial, it\'s over-engineered.',
      '',
      'Output: Code first. Then at most 3 lines: what was skipped, when to add it.',
      'Pattern: [code] → skipped: [X], add when [Y].',
      '',
      'Never simplify away: input validation, error handling, security, accessibility,',
      'or anything explicitly requested. Non-trivial logic needs one runnable check.',
    ].join('\n');
  }
}

module.exports = {
  filterSkillBodyForMode,
  getPonytailInstructions,
};
