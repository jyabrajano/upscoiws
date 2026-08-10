#!/usr/bin/env node
// =====================================================================
// check-history.js — is anything from the "never publish" list already
// in git history?
//
// Read-only. Runs git plumbing and prints; writes nothing, rewrites
// nothing, and never touches a remote. Exits non-zero if it finds
// something, so it chains with the rest:
//
//   node sync-sri.js && node sync-csp.js && node check-headers.js \
//     && node check-history.js && node check-drift.js
//
// WHY THIS EXISTS
//
// .gitignore opens with the sentence that makes this necessary:
// "Deleting a file later removes it from the site but NOT from git
// history — add it here before the first `git add`." That is a rule
// about the past, and .gitignore has no power over the past. It stops
// the next commit; it says nothing about the fifty behind you. A file
// listed there is not evidence it was never committed — very often it
// is listed *because* someone noticed it had been.
//
// deploy-schema.sql is the case that matters. .gitignore is right that
// it is "not a key (security lives in the database, not in secrecy)",
// and that framing is the correct one: nothing in the schema is a
// credential, and RLS does not weaken by being read. But it is a full
// map of tables, RPCs and policies for anyone probing the API, and
// there is no reason to hand it over. Worth removing; not worth
// panicking about.
//
// WHAT THIS CANNOT TELL YOU
//
// It walks objects reachable from refs. A commit that only the reflog
// or a dangling object still points at will not appear, and neither
// will anything in a fork, a mirror, a CI cache, or someone's clone.
// If the repo has been pushed anywhere public, treat what it finds as
// already disclosed and act accordingly — a purge tidies the record,
// it does not retract a download.
// =====================================================================

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;

// Patterns that are ignored for tidiness, not for secrecy. Finding one
// of these in history is noise, and drowning the real answer in it is
// how a report like this stops being read.
const NOT_INTERESTING = [
  ".DS_Store", "Thumbs.db", "node_modules/",
  "supabase/.temp/", "dist/", "dist-full/",
];

// Ignored, and finding it in history is a problem of a different order.
// These are the ones that mean rotate-then-purge rather than purge.
const SECRETS = [".env", ".env.*", "supabase/.env", "supabase/.env.*"];

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // Captured, not inherited. The first call is a probe for "is this
    // even a repo", and letting git print its own `fatal:` there means
    // the script's next line politely contradicts an error the reader
    // has already believed.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---- read the ignore list -------------------------------------------

function resolveIgnore() {
  for (const candidate of [".gitignore", "_gitignore"]) {
    const p = path.join(ROOT, candidate);
    if (fs.existsSync(p)) return { path: p, name: candidate };
  }
  return null;
}

const ignoreFile = resolveIgnore();
if (!ignoreFile) {
  console.error("check-history: no .gitignore (or _gitignore) here. Run this from the repo root.");
  process.exit(2);
}

const patterns = fs.readFileSync(ignoreFile.path, "utf8")
  .split("\n")
  .map(l => l.trim())
  .filter(l => l && !l.startsWith("#") && !l.startsWith("!"))
  .filter(l => !NOT_INTERESTING.includes(l));

if (!patterns.length) {
  console.log("check-history: nothing in the ignore list worth checking.");
  process.exit(0);
}

// A deliberately small glob translator. The ignore file uses `*`, a
// trailing `/`, and nothing else; anything more exotic would be a
// silent mismatch here, which is worse than not supporting it, so
// unknown syntax is reported rather than guessed at.
function toRegex(pattern) {
  if (/[\[\]{}?!]|\*\*/.test(pattern)) return null;
  const dir = pattern.endsWith("/");
  const body = dir ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  // No slash in the pattern means git matches it at any depth.
  const anchored = body.includes("/") ? "^" + escaped : "(^|.*/)" + escaped;
  return new RegExp(anchored + (dir ? "/" : "") + "$");
}

// ---- is this even a repo? -------------------------------------------

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  console.log("check-history: not a git repository — nothing to check.");
  console.log("(That is a clean slate: add .gitignore before the first `git add`.)");
  process.exit(0);
}

let refCount = 0;
try {
  refCount = git(["rev-list", "--all", "--count"]).trim();
} catch {
  refCount = "0";
}

if (refCount === "0") {
  console.log("check-history: no commits yet. Nothing can be in history.");
  process.exit(0);
}

// ---- every path any reachable commit ever held ----------------------

const seen = new Set();
for (const line of git(["rev-list", "--objects", "--all"]).split("\n")) {
  const sp = line.indexOf(" ");
  if (sp === -1) continue;                     // commit/tree with no path
  const p = line.slice(sp + 1).trim();
  if (p) seen.add(p);
}

const unsupported = [];
const hits = [];

for (const pattern of patterns) {
  const re = toRegex(pattern);
  if (!re) {
    unsupported.push(pattern);
    continue;
  }
  const matched = [...seen].filter(p => re.test(p)).sort();
  for (const file of matched) {
    let commits = "?";
    let first = "";
    let last = "";
    try {
      const log = git([
        "log", "--all", "--follow", "--format=%h %ad %s",
        "--date=short", "--", file,
      ]).trim().split("\n").filter(Boolean);
      commits = log.length;
      last = log[0] || "";
      first = log[log.length - 1] || "";
    } catch { /* --follow refuses on some paths; the finding stands */ }

    const inTree = fs.existsSync(path.join(ROOT, file));
    const isSecret = SECRETS.some(s => {
      const r = toRegex(s);
      return r && r.test(file);
    });
    hits.push({ file, pattern, commits, first, last, inTree, isSecret });
  }
}

// ---- report ---------------------------------------------------------

console.log(`check-history: ${refCount} commit(s), ${seen.size} distinct path(s) ever tracked`);
console.log(`  ignore list checked: ${patterns.length} pattern(s) from ${ignoreFile.name}`);
console.log("");

for (const p of unsupported) {
  console.log(`note: pattern "${p}" uses glob syntax this script does not translate. ` +
              "Check it by hand rather than reading a pass here as a clean result.\n");
}

if (hits.length === 0) {
  console.log("Clean: nothing on the never-publish list appears in any reachable commit.");
  console.log("");
  console.log("This covers refs only. Dangling objects, other clones, forks and CI");
  console.log("caches are outside what git can be asked here.");
  process.exit(0);
}

const secrets = hits.filter(h => h.isSecret);

console.error(`FOUND — ${hits.length} ignored path(s) are in git history:\n`);
for (const h of hits) {
  console.error(`  ${h.file}`);
  console.error(`      matched:  ${h.pattern}`);
  console.error(`      commits:  ${h.commits}${h.first ? `  (first ${h.first})` : ""}`);
  if (h.last) console.error(`      latest:   ${h.last}`);
  console.error(`      worktree: ${h.inTree ? "present (ignored now, but tracked before)" : "deleted — still in history"}`);
  console.error("");
}

if (secrets.length) {
  console.error("At least one of these is a secrets file.\n");
  console.error("  Rotate first, purge second. A rewritten history does not un-read a key");
  console.error("  that has already been fetched, and every second spent on the rewrite is");
  console.error("  a second the old value is still valid. For this repo that means:");
  console.error("  Supabase service-role key, the AI provider key, and anything else set");
  console.error("  with `supabase secrets set`.\n");
}

console.error("To remove them from history:\n");
console.error("  1. Make a backup clone you do not touch again:");
console.error("       git clone --mirror . ../repo-backup.git\n");
console.error("  2. Install git-filter-repo (the tool git itself recommends over");
console.error("     filter-branch, which is slow and gets subtle cases wrong):");
console.error("       pip install git-filter-repo\n");
console.error("  3. From a fresh clone of the remote — filter-repo refuses to run on a");
console.error("     repo with a remote still attached, on purpose:");
console.error("       git clone <url> repo-clean && cd repo-clean");
console.error("");
console.error("     One invocation, every path at once. Running filter-repo a second");
console.error("     time on a repo it has already rewritten needs --force, and reaching");
console.error("     for --force to get past that complaint is how people end up");
console.error("     rewriting something they did not mean to.");
console.error("");
console.error("       git filter-repo --invert-paths \\");
console.error(hits.map(h => `         --path '${h.file}'`).join(" \\\n"));
console.error("");
console.error("  4. Re-add the remote and force-push every ref:");
console.error("       git remote add origin <url>");
console.error("       git push --force --all && git push --force --tags\n");
console.error("  5. Tell everyone with a clone to re-clone. A pull onto old history");
console.error("     reintroduces every object you just removed, and it will look like");
console.error("     the purge silently failed.\n");
console.error("  6. If the remote is a public host, also ask it to garbage-collect.");
console.error("     Unreachable objects stay fetchable by SHA for a while, and forks");
console.error("     made before the rewrite keep their own copy regardless.\n");
console.error("Then re-run this script on the clean clone.\n");

process.exit(1);
