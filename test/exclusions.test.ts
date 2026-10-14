import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExclusions } from "../exclusions.ts";

for (const [patterns, path, excluded] of [
  [["package-lock.json"], "package-lock.json", true],
  [["package-lock.json"], "web/package-lock.json", false],
  [["**/package-lock.json"], "web/package-lock.json", true],
  [["**/package-lock.json"], "package-lock.json", true],
  [["vendor"], "vendor/a/b.go", true],
  [["vendor/"], "vendor/a/b.go", true],
  [["./vendor"], "vendor/a/b.go", true],
  [["vendor"], "src/vendor/b.go", false],
  [["*.lock"], "yarn.lock", true],
  [["*.lock"], "a/yarn.lock", false],
  [["**/*.lock"], "a/b/yarn.lock", true],
  [["src/**/*.gen.ts"], "src/a/b/x.gen.ts", true],
  [["src/**/*.gen.ts"], "src/x.gen.ts", true],
  [["src/**/*.gen.ts"], "src/x.ts", false],
  [["src/gen/**"], "src/gen/a/b.ts", true],
  [["src/gen/*"], "src/gen/a/b.ts", true],
  [["f?.ts"], "f1.ts", true],
  [["f?.ts"], "f/.ts", false],
  [["a.b"], "aXb", false],
  [["src/(x)+.ts"], "src/(x)+.ts", true],
  [["dist", "**/*.snap"], "pkg/a.snap", true],
  [[], "src/a.ts", false],
] as [string[], string, boolean][]) {
  test(`--exclude ${JSON.stringify(patterns)} ${excluded ? "excludes" : "keeps"} ${path}`, () => {
    assert.equal(compileExclusions(patterns)({ path }), excluded);
  });
}

test("--exclude excludes a rename only when both paths are excluded", () => {
  const excluded = compileExclusions(["gen"]);
  assert.equal(excluded({ path: "gen/b.ts", previousPath: "gen/a.ts" }), true);
  assert.equal(excluded({ path: "src/b.ts", previousPath: "gen/a.ts" }), false);
  assert.equal(excluded({ path: "gen/b.ts", previousPath: "src/a.ts" }), false);
});

test("--exclude rejects paths that would match everything or nothing", () => {
  for (const pattern of ["", "  ", "/", "./", "."]) {
    assert.throws(() => compileExclusions([pattern]), /Invalid --exclude path/);
  }
});
