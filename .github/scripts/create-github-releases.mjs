#!/usr/bin/env node
// Create one GitHub Release per just-published package, with a small, bounded
// body — never the package's CHANGELOG.md.
//
// Why this exists instead of changesets/action's built-in createGithubReleases:
// in this fork the package CHANGELOG.md files are *upstream-owned* (Keep-a-
// Changelog format, `## [x.y.z] - date`, merge=union — see FORK-CHANGELOG.md).
// changesets/action builds a Release body by matching a heading whose text
// equals the version (`## 0.31.0`); the bracket+date headings never match, so
// it falls back to dumping the ENTIRE file (coding-agent's is 400KB+) as the
// body, which exceeds GitHub's 125000-char Release-body cap → 422 ("body is too
// long") → the whole publish job reds. We disable that and cut Releases here
// with a concise body that points at the fork's real notes (FORK-CHANGELOG.md).
//
// Usage: node create-github-releases.mjs '<publishedPackages JSON>'
//   publishedPackages: changesets/action `publishedPackages` output, e.g.
//   [{"name":"@valkyriweb/pi-coding-agent","version":"0.31.0"}]

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const BODY_LIMIT = 124000; // < GitHub's 125000 hard cap

const published = JSON.parse(process.argv[2] || "[]");
if (!Array.isArray(published) || published.length === 0) {
  console.log("No published packages — nothing to release.");
  process.exit(0);
}

const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const repo = process.env.GITHUB_REPOSITORY || "lue-labs/pi-mono";
const forkChangelogUrl = `${serverUrl}/${repo}/blob/main/FORK-CHANGELOG.md`;

// Map package name -> directory by scanning tracked package.json files.
const pkgFiles = execFileSync("git", ["ls-files", "**/package.json", "package.json"])
  .toString()
  .trim()
  .split("\n")
  .filter((f) => f && !f.includes("node_modules"));

const nameToDir = new Map();
for (const f of pkgFiles) {
  try {
    const pkg = JSON.parse(readFileSync(f, "utf8"));
    if (pkg.name) nameToDir.set(pkg.name, dirname(f));
  } catch {
    /* ignore unparseable package.json */
  }
}

// Pin every gh call to the fork repo: this clone has both an `origin`
// (lue-labs/pi-mono) and an `upstream` (earendil-works/pi-mono) remote, so
// gh's default-repo resolution can pick the wrong one.
function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag, "-R", repo], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let created = 0;
let skipped = 0;
for (const { name, version } of published) {
  const tag = `${name}@${version}`;
  if (releaseExists(tag)) {
    console.log(`• ${tag} — release already exists, skipping`);
    skipped++;
    continue;
  }

  const dir = nameToDir.get(name);
  const lines = [
    `Fork release of \`${name}\` \`${version}\`, published to GitHub Packages (@valkyriweb scope).`,
    "",
    `- **Fork release notes:** [FORK-CHANGELOG.md](${forkChangelogUrl})`,
  ];
  if (dir) {
    lines.push(
      `- **Upstream history:** \`${dir}/CHANGELOG.md\` (Keep-a-Changelog, from earendil-works/pi-mono)`,
    );
  }
  let body = lines.join("\n");
  if (body.length > BODY_LIMIT) body = body.slice(0, BODY_LIMIT);

  execFileSync("gh", ["release", "create", tag, "-R", repo, "--title", tag, "--notes", body], {
    stdio: "inherit",
  });
  console.log(`✓ ${tag} — release created`);
  created++;
}

console.log(`Done: ${created} created, ${skipped} skipped.`);
