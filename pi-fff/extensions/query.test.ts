import { expect } from "chai";
import { buildQuery, normalizePathConstraint } from "./lib/query";

const cwd = "/tmp/workspace";

describe("path constraint normalization", () => {
  it("converts absolute in-workspace paths to repo-relative constraints", () => {
    expect(normalizePathConstraint("/tmp/workspace/.agents/**", cwd)).to.equal(
      ".agents/",
    );
    expect(normalizePathConstraint("/tmp/workspace/.agents/plans/**", cwd)).to.equal(
      ".agents/plans/",
    );
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => normalizePathConstraint("/tmp/other/.agents/**", cwd)).to.throw(
      "Path constraint must be relative to the workspace",
    );
  });

  it("collapses only simple trailing recursive directory globs", () => {
    expect(normalizePathConstraint(".agents/**", cwd)).to.equal(".agents/");
    expect(normalizePathConstraint("src/**/*", cwd)).to.equal("src/");
    expect(normalizePathConstraint("src/**/*.ts", cwd)).to.equal("src/**/*.ts");
    expect(normalizePathConstraint("{src,lib}/**", cwd)).to.equal("{src,lib}/**");
  });

  it("builds find queries with normalized include and exclude constraints", () => {
    expect(
      buildQuery("/tmp/workspace/.agents/**", "*", "/tmp/workspace/test/**", cwd),
    ).to.equal(".agents/ !test/ *");
  });

  it("treats path='.' as workspace root", () => {
    expect(normalizePathConstraint(".", cwd)).to.equal(null);
    expect(normalizePathConstraint("./", cwd)).to.equal(null);
    expect(buildQuery(".", "needle", undefined, cwd)).to.equal("needle");
  });

  it("treats absolute workspace root as no constraint", () => {
    expect(normalizePathConstraint(cwd, cwd)).to.equal(null);
    expect(buildQuery(cwd, "needle", undefined, cwd)).to.equal("needle");
  });

  it("normalizes bare directories and file paths", () => {
    expect(normalizePathConstraint("app", cwd)).to.equal("app/");
    expect(normalizePathConstraint("src/nested", cwd)).to.equal("src/nested/");
    expect(normalizePathConstraint("/tmp/workspace/src/main.rs", cwd)).to.equal(
      "src/main.rs",
    );
    expect(normalizePathConstraint("/tmp/workspace/src", cwd)).to.equal("src/");
    expect(normalizePathConstraint("/tmp/workspace/src/**/*.ts", cwd)).to.equal(
      "src/**/*.ts",
    );
  });
});
