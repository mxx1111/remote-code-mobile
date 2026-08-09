import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const colors = ["violet", "mint", "orange", "blue"];

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shortName(name) {
  const parts = name.split(/[-_\s]+/u).filter(Boolean);
  if (parts.length > 1) {
    return parts.slice(0, 2).map((part) => Array.from(part)[0] ?? "").join("").toUpperCase();
  }
  return Array.from(name).filter((character) => /[\p{L}\p{N}]/u.test(character)).slice(0, 2).join("").toUpperCase();
}

function displayPath(path) {
  const userHome = homedir();
  return path === userHome || path.startsWith(`${userHome}${sep}`)
    ? `~/${relative(userHome, path)}`.replace(/\/$/u, "")
    : path;
}

function gitBranch(path) {
  const result = spawnSync("git", ["-C", path, "branch", "--show-current"], {
    encoding: "utf8",
    timeout: 1_500,
  });
  if (result.status !== 0) return "folder";
  return result.stdout.trim() || "detached";
}

export function createProjectCatalog({ machineName, rootPath, sessionName }) {
  const resolvedRoot = resolve(rootPath);
  let cachedAt = 0;
  let cachedProjects = [];

  const scan = () => readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const cwd = resolve(join(resolvedRoot, entry.name));
      if (!cwd.startsWith(`${resolvedRoot}${sep}`)) return null;
      const hash = stableHash(cwd);
      return {
        activity: "本机项目",
        branch: gitBranch(cwd),
        color: colors[Number.parseInt(hash.slice(0, 2), 16) % colors.length],
        cwd,
        id: entry.name,
        machine: machineName,
        name: entry.name,
        path: displayPath(cwd),
        session: sessionName,
        shortName: shortName(entry.name) || "PR",
        windowName: `project-${hash.slice(0, 10)}`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));

  const list = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (refresh || !cachedProjects.length || now - cachedAt > 5_000) {
      cachedProjects = scan();
      cachedAt = now;
    }
    return cachedProjects;
  };

  return {
    get(projectId) {
      return list().find((project) => project.id === projectId) ?? null;
    },
    list,
    rootLabel: displayPath(resolvedRoot),
  };
}
