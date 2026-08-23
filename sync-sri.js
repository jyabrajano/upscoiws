#!/usr/bin/env node
const fs = require("fs");

const path = require("path");

const https = require("https");

const crypto = require("crypto");

const ROOT = __dirname;

const LOCKFILE = path.join(ROOT, "sri-lock.json");

const PAGES = [ "dashboard.html", "editaccount.html", "index.html", "privacy.html", "registration.html", "reset-password.html", "soa.html", "terms.html", "users.html" ];

const UPDATE = process.argv.includes("--update");

function fail(message) {
  console.error("sync-sri: " + message);
  process.exit(1);
}

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "User-Agent": "sync-sri"
      }
    }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) return reject(new Error("too many redirects"));
        return resolve(download(new URL(res.headers.location, url).href, redirectsLeft - 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sri(buffer) {
  return "sha384-" + crypto.createHash("sha384").update(buffer).digest("base64");
}

const MARKERS = [ {
  test: /supabase/i,
  marker: "createClient"
}, {
  test: /xlsx|sheetjs/i,
  marker: "XLSX"
} ];

function markerFor(url) {
  const hit = MARKERS.find(m => m.test.test(url));
  return hit ? hit.marker : null;
}

function readLock() {
  if (!fs.existsSync(LOCKFILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE, "utf8"));
  } catch (err) {
    fail(`sri-lock.json is not valid JSON (${err.message}). Delete it and re-run with --update.`);
  }
}

const CDN_TAG_RE = /<script\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["'][^>]*><\/script>/gi;

const COMMENTS_RE = /<!--[\s\S]*?-->/g;

const found = new Map;

for (const file of PAGES) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    console.warn(`sync-sri: ${file} — not found, skipped.`);
    continue;
  }
  const bare = fs.readFileSync(p, "utf8").replace(COMMENTS_RE, "");
  for (const m of bare.matchAll(CDN_TAG_RE)) {
    if (!found.has(m[1])) found.set(m[1], []);
    found.get(m[1]).push(file);
  }
}

if (found.size === 0) {
  console.log("sync-sri: no cross-origin scripts in any page — nothing to do.");
  console.log("sync-sri: (that is the expected result on a vendor/ build.)");
  process.exit(0);
}

(async () => {
  const lock = readLock();
  const nextLock = {};
  const hashes = new Map;
  let changed = false;
  for (const [url, files] of found) {
    process.stdout.write(`sync-sri: ${url} … `);
    let body;
    try {
      body = await download(url);
    } catch (err) {
      console.log("failed");
      fail(`couldn't download ${url} — ${err.message}`);
    }
    const marker = markerFor(url);
    if (marker && !body.includes(marker)) {
      console.log("failed");
      fail(`${url} came back without "${marker}" in it (${body.length} bytes). ` + "That is usually an error page served with a 200. Nothing was written.");
    }
    const hash = sri(body);
    const recorded = lock[url];
    if (recorded && recorded !== hash && !UPDATE) {
      console.log("HASH MISMATCH");
      fail(`${url} does not match sri-lock.json.\n` + `  expected ${recorded}\n` + `  received ${hash}\n` + "Nothing was written. A pinned version whose bytes changed is exactly\n" + "the event this file exists to stop — understand it before you proceed.\n" + "If you meant to change versions, re-run with --update.");
    }
    hashes.set(url, hash);
    nextLock[url] = hash;
    if (!recorded) {
      console.log(`locked ${hash}`);
      changed = true;
    } else if (recorded !== hash) {
      console.log(`updated ${hash}`);
      changed = true;
    } else {
      console.log("ok");
    }
  }
  let edited = 0;
  let alreadyCurrent = 0;
  for (const file of PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    const updated = src.replace(CDN_TAG_RE, (tag, url) => {
      const hash = hashes.get(url);
      if (!hash) return tag;
      const attrs = tag.replace(/\sintegrity\s*=\s*["'][^"']*["']/gi, "").replace(/\scrossorigin\s*=\s*["'][^"']*["']/gi, "").replace(/\scrossorigin(?=[\s>])/gi, "").replace(/><\/script>$/i, "");
      return `${attrs} integrity="${hash}" crossorigin="anonymous"><\/script>`;
    });
    if (updated === src) {
      alreadyCurrent++;
      continue;
    }
    fs.writeFileSync(p, updated, "utf8");
    edited++;
    console.log(`sync-sri: updated ${file}`);
  }
  fs.writeFileSync(LOCKFILE, JSON.stringify(nextLock, null, 2) + "\n");
  const violations = [];
  for (const file of PAGES) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    const bare = fs.readFileSync(p, "utf8").replace(COMMENTS_RE, "");
    for (const m of bare.matchAll(CDN_TAG_RE)) {
      const tag = m[0];
      if (!/\bintegrity\s*=/i.test(tag)) {
        violations.push(`${file}: ${m[1]} has no integrity=`);
      } else if (!/\bcrossorigin\b/i.test(tag)) {
        violations.push(`${file}: ${m[1]} has integrity= but no crossorigin — the browser ` + "will block it even though the hash is right");
      }
    }
  }
  if (violations.length) {
    console.error("\nsync-sri: cross-origin scripts without a usable hash:\n");
    violations.forEach(v => console.error("  " + v));
    process.exit(1);
  }
  if (changed) {
    console.log("sync-sri: sri-lock.json updated — commit it with the pages.");
  }
  console.log(`sync-sri: done — ${found.size} script(s) hashed, ${edited} page(s) updated, ` + `${alreadyCurrent} already current.`);
})();
