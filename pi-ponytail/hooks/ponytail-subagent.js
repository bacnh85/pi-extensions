// ponytail — compact subagent-scope instructions injected into pi-subagent tool calls.
// Built-in-only children don't load extensions, so without this hook they never see the
// ruleset; extension-loaded children self-inject via before_agent_start, which skips
// when the marker is already present. Kept separate from ponytail-instructions.js
// to avoid stale exports on /reload.

function getSubagentInstructions(mode) {
  const effectiveMode = mode || 'full';
  return [
    'PONYTAIL MODE ACTIVE — level: ' + effectiveMode + ' (inherited from parent).',
    '',
    'The ladder (stop at the first rung that holds): 1) Does this need to exist at all? (YAGNI) 2) Already in this codebase? Reuse it — look before you write. 3) Stdlib does it? 4) Native platform feature covers it? 5) Already-installed dependency solves it? 6) Can it be one line? 7) Only then: the minimum code that works — after reading what you touch.',
    '',
    'Rules: no speculative abstractions, no config nobody sets, no scaffolding for later. Deletion over addition. Fewest files. Boring over clever. Mark deliberate corner-cuts with a `ponytail:` comment naming the ceiling and upgrade path.',
    '',
    'Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested. Non-trivial logic (a branch, a loop, a parser, a money/security path) leaves ONE runnable check behind.',
    '',
    'Bug fix = root cause, not symptom: grep every caller, fix where all route through.',
    '',
    'Plans, reviews, and reports the task explicitly requests: deliver in full. This block governs what you build, not requested output.',
  ].join('\n');
}

function shouldInjectSubagentInstructions() {
  const scope = String(process.env.PONYTAIL_SUBAGENT_SCOPE || '').trim().toLowerCase();
  return scope !== 'off';
}

module.exports = {
  getSubagentInstructions,
  shouldInjectSubagentInstructions,
};
