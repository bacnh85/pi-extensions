# pi-ux

Anti-slop UI/UX design discipline extension. Forks the pi-ponytail shape
(hook + command + skill) for design discipline instead of code laziness.

Before writing any code here, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse it.
3. Does the standard library already do this? Use it.
4. Can it be one line? Make it one line.
5. Only then: write the minimum code that works.

This is a **discipline enforcer**, not a generator. Generation stays with
`agy_execute` (Gemini/Claude) and the main Pi models (DeepSeek-v4, GLM-5.2).
pi-ux only makes sure their output lands inside a defensible design system.

## What NOT to build here

- ❌ A design-token generator (use agy/Gemini or reuse shadcn/ui).
- ❌ A bundled CSS framework (reference only).
- ❌ A UI renderer (that's agy + the main model's job).
- ❌ TypeScript (plain JS like ponytail — zero deps).

## Test

```bash
npm test   # node --test extensions/test/*.test.js
```
