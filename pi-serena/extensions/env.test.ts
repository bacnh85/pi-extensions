/**
 * Unit tests for the dot-env loader (lib/env.ts): precedence order,
 * process.env priority, dotenv value parsing, and isolation from the
 * developer's real global Pi config (~/.pi/agent).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "chai";
import { loadDotenvValues } from "./lib/env";

/**
 * Create an isolated temp dir; point PI_CODING_AGENT_DIR at a "global" subdir
 * so piConfigDirs() resolves inside the temp dir instead of the developer's
 * real ~/.pi/agent (which may contain SERENA_* keys and would make tests
 * environmentally fragile). Restored in finally.
 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-env-"));
  const globalDir = path.join(dir, "global");
  fs.mkdirSync(globalDir);
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalDir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** cwd dot files live at <dir>/.env.local and <dir>/.env; global at <dir>/global/.env* */
function globalEnvFile(dir: string, name: ".env" | ".env.local"): string {
  return path.join(dir, "global", name);
}

describe("loadDotenvValues", () => {
  it("loads SERENA_* values from cwd .env.local and .env (first wins)", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ".env.local"), "SERENA_LANGUAGE_BACKEND=JetBrains\n");
      fs.writeFileSync(path.join(dir, ".env"), "SERENA_LANGUAGE_BACKEND=LSP\nSERENA_BRIDGE_WEB_DASHBOARD=0\n");
      const env = loadDotenvValues(dir, true);
      expect(env.SERENA_LANGUAGE_BACKEND).to.equal("JetBrains"); // .env.local wins
      expect(env.SERENA_BRIDGE_WEB_DASHBOARD).to.equal("0"); // falls through to .env
    });
  });

  it("cwd dot files take precedence over global config dot files", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ".env"), "SERENA_LANGUAGE_BACKEND=cwd\n");
      fs.writeFileSync(globalEnvFile(dir, ".env.local"), "SERENA_LANGUAGE_BACKEND=global-local\n");
      fs.writeFileSync(globalEnvFile(dir, ".env"), "SERENA_LANGUAGE_BACKEND=global\n");
      const env = loadDotenvValues(dir, true);
      expect(env.SERENA_LANGUAGE_BACKEND).to.equal("cwd");
    });
  });

  it("loads values from global config when cwd files omit them", () => {
    withTempDir((dir) => {
      fs.writeFileSync(globalEnvFile(dir, ".env.local"), "SERENA_BRIDGE_WEB_DASHBOARD=0\n");
      fs.writeFileSync(globalEnvFile(dir, ".env"), "SERENA_LANGUAGE_BACKEND=JetBrains\n");
      const env = loadDotenvValues(dir, true);
      expect(env.SERENA_BRIDGE_WEB_DASHBOARD).to.equal("0"); // global .env.local
      expect(env.SERENA_LANGUAGE_BACKEND).to.equal("JetBrains"); // global .env
    });
  });

  it("does not override values already in process.env", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ".env.local"), "SERENA_LANGUAGE_BACKEND=JetBrains\n");
      const prev = process.env.SERENA_LANGUAGE_BACKEND;
      process.env.SERENA_LANGUAGE_BACKEND = "LSP";
      try {
        const env = loadDotenvValues(dir, true);
        expect(env.SERENA_LANGUAGE_BACKEND).to.be.undefined; // excluded: already in process.env
      } finally {
        if (prev === undefined) delete process.env.SERENA_LANGUAGE_BACKEND;
        else process.env.SERENA_LANGUAGE_BACKEND = prev;
      }
    });
  });

  it("parses quoted values, inline comments, export prefix, and keeps # without preceding whitespace", () => {
    withTempDir((dir) => {
      fs.writeFileSync(
        path.join(dir, ".env"),
        [
          'SERENA_LANGUAGE_BACKEND="JetBrains" # backend selection',
          "export SERENA_BRIDGE_WEB_DASHBOARD=1",
          "SERENA_HASH=value#notcomment",
        ].join("\n"),
      );
      const env = loadDotenvValues(dir, true);
      expect(env.SERENA_LANGUAGE_BACKEND).to.equal("JetBrains");
      expect(env.SERENA_BRIDGE_WEB_DASHBOARD).to.equal("1"); // export prefix stripped
      expect(env.SERENA_HASH).to.equal("value#notcomment"); // # needs preceding whitespace
    });
  });

  it("applies \\n/\\r/\\t escapes inside quoted values", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ".env"), "SERENA_ESCAPED='a\\nb\\tc'\n");
      const env = loadDotenvValues(dir, true);
      expect(env.SERENA_ESCAPED).to.equal("a\nb\tc");
    });
  });

  it("skips missing files and comment-only lines", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ".env"), "# just a comment\n\n");
      expect(loadDotenvValues(dir, true)).to.deep.equal({});
    });
  });
});
