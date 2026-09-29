// Shared pi-ux instruction builder for Claude hooks and Pi extension.
//
// Reads the skill body, strips frontmatter, prepends a mode banner.
// ponytail: no per-mode row filtering needed here — the UX method is mode-
// invariant; only the banner differs (strict enforces the audit gate).

const fs = require('fs');
const path = require('path');
const { DEFAULT_MODE, normalizeMode } = require('./ux-config');
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'ux-design', 'SKILL.md');

// Memoized SKILL.md read: before_agent_start fires every turn, so one stat
// per call beats readFileSync+parse every time. Re-read only when
// path/mtime/size change (same pattern as ponytail-config's readConfig).
let skillCache = { path: SKILL_PATH, mtimeMs: -1, size: -1, body: null };

function readSkillBody() {
  let st;
  try {
    st = fs.statSync(SKILL_PATH);
    if (
      skillCache.path === SKILL_PATH &&
      skillCache.mtimeMs === st.mtimeMs &&
      skillCache.size === st.size &&
      skillCache.body !== null
    ) {
      return skillCache.body;
    }
  } catch (e) {
    // stat failed: fall through to the read's own error handling
  }
  const body = String(fs.readFileSync(SKILL_PATH, 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
  skillCache = { path: SKILL_PATH, mtimeMs: st.mtimeMs, size: st.size, body };
  return body;
}

function getUxInstructions(mode) {
  const configuredMode = normalizeMode(mode) || DEFAULT_MODE;
  const effectiveMode = normalizeMode(configuredMode) || DEFAULT_MODE;

  const banner = effectiveMode === 'strict'
    ? 'UX DISCIPLINE ACTIVE — level: strict. Run ux_audit before declaring a screen done; block handoff on fail.'
    : 'UX DISCIPLINE ACTIVE — level: lite. Anti-slop guardrail enforced; audit gate recommended but not blocking.';

  try {
    return banner + '\n\n' + readSkillBody();
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
