import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createProjectCatalog } from "./project-catalog.mjs";

test("createProjectCatalog tests", async (t) => {
  let tempRoot;

  t.beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "rcm-catalog-test-"));
  });

  t.afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await t.test("lists directories and excludes dotfile directories and regular files", () => {
    mkdirSync(join(tempRoot, "proj-a"));
    mkdirSync(join(tempRoot, ".hidden-dir"));
    writeFileSync(join(tempRoot, "some-file.txt"), "hello");

    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: tempRoot,
      sessionName: "default-session",
    });

    const projects = catalog.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "proj-a");
    assert.equal(projects[0].name, "proj-a");
    assert.equal(projects[0].machine, "macbook");
    assert.equal(projects[0].session, "default-session");
  });

  await t.test("symlink pointing outside the root does not produce a project escaping resolvedRoot", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "rcm-outside-"));
    try {
      symlinkSync(outsideDir, join(tempRoot, "symlink-escape"), "dir");
      const catalog = createProjectCatalog({
        machineName: "macbook",
        rootPath: tempRoot,
        sessionName: "default-session",
      });

      const projects = catalog.list();
      // symlink cwd resolves outside tempRoot, so containment check fails and filters it out
      assert.equal(projects.find((p) => p.id === "symlink-escape"), undefined);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  await t.test("get() returns project details for valid id and null for unknown id", () => {
    mkdirSync(join(tempRoot, "alpha"));
    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: tempRoot,
      sessionName: "default-session",
    });

    const found = catalog.get("alpha");
    assert.notEqual(found, null);
    assert.equal(found?.id, "alpha");

    const missing = catalog.get("non-existent");
    assert.equal(missing, null);
  });

  await t.test("non-git directory reports branch 'folder', git directory reports actual branch", () => {
    mkdirSync(join(tempRoot, "plain-dir"));
    const gitDir = join(tempRoot, "git-dir");
    mkdirSync(gitDir);
    spawnSync("git", ["init", "-b", "feature/my-branch", gitDir], { encoding: "utf8" });

    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: tempRoot,
      sessionName: "default-session",
    });

    const plain = catalog.get("plain-dir");
    assert.equal(plain?.branch, "folder");

    const gitProject = catalog.get("git-dir");
    assert.equal(gitProject?.branch, "feature/my-branch");
  });

  await t.test("sorting respects numeric: true (e.g. project2 before project10)", () => {
    mkdirSync(join(tempRoot, "project10"));
    mkdirSync(join(tempRoot, "project2"));
    mkdirSync(join(tempRoot, "project1"));

    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: tempRoot,
      sessionName: "default-session",
    });

    const list = catalog.list();
    assert.deepEqual(
      list.map((p) => p.name),
      ["project1", "project2", "project10"]
    );
  });

  await t.test("5-second cache prevents rescan unless refresh: true is passed", async () => {
    mkdirSync(join(tempRoot, "first"));
    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: tempRoot,
      sessionName: "default-session",
    });

    const initial = catalog.list();
    assert.equal(initial.length, 1);

    mkdirSync(join(tempRoot, "second"));
    const cached = catalog.list();
    assert.equal(cached.length, 1);
    assert.equal(cached[0].id, "first");

    const refreshed = catalog.list({ refresh: true });
    assert.equal(refreshed.length, 2);
    assert.deepEqual(
      refreshed.map((p) => p.name),
      ["first", "second"]
    );
  });

  await t.test("handles non-existent root directory gracefully or when root does not exist", () => {
    const nonExistentPath = join(tmpdir(), "non-existent-dir-" + Date.now());
    const catalog = createProjectCatalog({
      machineName: "macbook",
      rootPath: nonExistentPath,
      sessionName: "default-session",
    });

    assert.ok(catalog.rootLabel);
    assert.throws(() => {
      catalog.list();
    }, /ENOENT/);
  });
});
