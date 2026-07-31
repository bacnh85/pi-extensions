// Shared pi-ux instruction builder for Claude hooks and Pi extension.
//
// Reads the skill body, strips frontmatter, prepends a mode banner.
// ponytail: no per-mode row filtering needed here — the UX method is mode-
// invariant; only the banner differs (strict enforces the audit gate).

const fs = require('fs');
const path = require('path');
const { DEFAULT_MODE, normalizeMode, normalizePersistedMode } = require('./ux-config');
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'ux-design', 'SKILL.md');

function getUxInstructions(mode) {
  const configuredMode = normalizePersistedMode(mode) || DEFAULT_MODE;
  const effectiveMode = normalizeMode(configuredMode) || DEFAULT_MODE;

  const banner = effectiveMode === 'strict'
    ? 'UX DISCIPLINE ACTIVE — level: strict. Run ux_audit before declaring a screen done; block handoff on fail.'
    : 'UX DISCIPLINE ACTIVE — level: lite. Anti-slop guardrail enforced; audit gate recommended but not blocking.';

  try {
    const body = String(fs.readFileSync(SKILL_PATH, 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
    return banner + '\n\n' + body;
  } catch (e) {
    // ponytail: SKILL.md missing or unreadable — compact inline fallback keeps the guardrail.
    return [
      banner,
      '',
      'You implement UI INSIDE an existing design system. You do NOT invent visual language.',
      '- Tokens ONLY (colour/type/spacing/radius/elevation). No off-system values.',
      '- Elevation: named levels only. Never invent shadow blur/opacity.',
      '- Accent: ONLY the defined accent token. No purple/indigo glow unless requested.',
      '- Type: modular scale only. No custom font sizes.',
      '- Spacing: 8px grid via tokens. No magic pixel values.',
      '- Every interactive element declares: default, hover, focus-visible, active, disabled',
      '  + error/empty/loading where relevant.',
      '- Before markup: output a 1-line inventory of components + states.',
      '- If ambiguous, ASK. Do not guess aesthetics.',
    ].join('\n');
  }
}

module.exports = { getUxInstructions };
