#!/usr/bin/env node
const fs = require("fs");

const path = require("path");

const terser = require("terser");

const {parse: parse} = require("node-html-parser");

const acorn = require("acorn");

const ts = require("typescript");

const SRC = __dirname;

const ALL = process.argv.includes("--all");

const OUT = path.join(SRC, ALL ? "dist-full" : "dist");

const SHIPPED_JS = [ "config.js", "approval.js", "sheets-config.js", "page-index.js", "page-dashboard.js", "page-soa.js", "page-users.js", "page-registration.js", "page-editaccount.js", "page-reset-password.js" ];

const SHIPPED_HTML = [ "index.html", "dashboard.html", "soa.html", "users.html", "registration.html", "editaccount.html", "reset-password.html", "privacy.html", "terms.html" ];

const ARCHIVE_JS = [ "sync-sri.js", "sync-csp.js", "sync-vendor.js", "check-drift.js", "build-clean.js" ];

const ARCHIVE_HTML = [ "email-confirm-signup.html", "email-reset-password.html" ];

const ARCHIVE_VERBATIM = [ "deploy-schema.sql", "README.md", "VERCEL.md" ];

const EDGE_ROOT = path.join(SRC, "supabase", "functions");

const JS = ALL ? [ ...SHIPPED_JS, ...ARCHIVE_JS ] : SHIPPED_JS;

const HTML = ALL ? [ ...SHIPPED_HTML, ...ARCHIVE_HTML ] : SHIPPED_HTML;

const VERBATIM = [ "vercel.json", "UPSeal.png", "htaccess", "gitignore", "vercelignore" ].concat(ALL ? ARCHIVE_VERBATIM : []);

function resolve(name) {
  if (![ "htaccess", "gitignore", "vercelignore" ].includes(name)) return {
    from: name,
    to: name
  };
  for (const candidate of [ `.${name}`, `_${name}` ]) {
    if (fs.existsSync(path.join(SRC, candidate))) return {
      from: candidate,
      to: `.${name}`
    };
  }
  return null;
}

const TERSER = {
  compress: false,
  mangle: false,
  format: {
    comments: false,
    beautify: true,
    indent_level: 2,
    preserve_annotations: false
  }
};

const PROBE = {
  compress: true,
  mangle: true,
  format: {
    comments: false
  }
};

async function stripJs(code, label) {
  const out = await terser.minify(code, TERSER);
  if (out.error) throw new Error(`${label}: ${out.error}`);
  const a = await terser.minify(code, PROBE);
  const b = await terser.minify(out.code, PROBE);
  if (a.code !== b.code) throw new Error(`${label}: stripped output is not equivalent to the original`);
  return out.code;
}

function stripCssInTemplates(code) {
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true
  });
  const targets = [];
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
      const q = node.quasis[0];
      const body = code.slice(q.start, q.end);
      if (body.includes("/*") && body.includes("{") && body.includes(";") && /[a-z-]+\s*:/i.test(body)) {
        targets.push({
          start: q.start,
          end: q.end,
          before: body
        });
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  const spans = [];
  let out = code;
  for (const t of targets.sort((a, b) => b.start - a.start)) {
    const after = stripCss(t.before);
    if (after === t.before) continue;
    spans.push({
      ...t,
      after: after
    });
    out = out.slice(0, t.start) + after + out.slice(t.end);
  }
  return {
    code: out,
    spans: spans
  };
}

function verifyTemplates(before, after, spans, label) {
  let a = before;
  let b = after;
  for (const s of spans) {
    if (s.after !== stripCss(s.before)) throw new Error(`${label}: template literal was altered beyond comment removal`);
    a = a.replace(s.before, "\0");
    b = b.replace(s.after, "\0");
  }
  if (a !== b) throw new Error(`${label}: something outside a template literal changed`);
}

function mustParse(code, label) {
  try {
    acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
      allowReturnOutsideFunction: true
    });
  } catch (err) {
    throw new Error(`${label}: output does not parse -- ${err.message}`);
  }
}

async function cleanJs(code, label) {
  const stripped = await stripJs(code, label);
  const {code: out, spans: spans} = stripCssInTemplates(stripped);
  if (spans.length) verifyTemplates(stripped, out, spans, label); else if (out !== stripped) throw new Error(`${label}: rewritten but no spans were recorded`);
  mustParse(out, label);
  return out;
}

const TS_TARGET = {
  compilerOptions: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    removeComments: true
  }
};

function transpile(code, label) {
  const out = ts.transpileModule(code, TS_TARGET);
  const errs = (out.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errs.length) throw new Error(`${label}: ${ts.flattenDiagnosticMessageText(errs[0].messageText, " ")}`);
  return out.outputText;
}

function cleanTs(code, label) {
  const sf = ts.createSourceFile(label, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const bad = (sf.parseDiagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (bad.length) throw new Error(`${label}: source does not parse -- ${ts.flattenDiagnosticMessageText(bad[0].messageText, " ")}`);
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed
  });
  const out = printer.printFile(sf);
  if (transpile(code, label) !== transpile(out, `${label} (stripped)`)) {
    throw new Error(`${label}: stripped output is not equivalent to the original`);
  }
  return out.endsWith("\n") ? out : out + "\n";
}

function stripCss(css) {
  let out = "";
  for (let i = 0; i < css.length; ) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      if (out.endsWith("\n")) while (i < css.length && (css[i] === " " || css[i] === "\t")) i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
}

const RAW_TEXT = [ "script", "style", "pre", "textarea" ];

function stripHtmlComments(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("\x3c!--", i)) {
      const end = html.indexOf("--\x3e", i + 4);
      i = end === -1 ? html.length : end + 3;
      if (/(^|\n)[ \t]*$/.test(out)) {
        while (i < html.length && (html[i] === " " || html[i] === "\t")) i += 1;
        if (html[i] === "\n") i += 1;
        out = out.replace(/[ \t]*$/, "");
      }
      continue;
    }
    const open = /^<([a-z]+)\b[^>]*>/i.exec(html.slice(i));
    if (open && RAW_TEXT.includes(open[1].toLowerCase())) {
      const close = new RegExp(`</${open[1]}\\s*>`, "i");
      const rest = html.slice(i + open[0].length);
      const m = close.exec(rest);
      const stop = m ? i + open[0].length + m.index + m[0].length : html.length;
      out += html.slice(i, stop);
      i = stop;
      continue;
    }
    out += html[i];
    i += 1;
  }
  return out;
}

async function stripHtml(html, label) {
  let out = stripHtmlComments(html);
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_, open, css, close) => open + stripCss(css) + close);
  const blocks = [ ...out.matchAll(/(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi) ];
  for (const b of blocks.reverse()) {
    const [full, open, attrs, body, close] = b;
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
    const cleaned = await cleanJs(body, `${label} inline <script>`);
    out = out.slice(0, b.index) + open + "\n" + cleaned + "\n" + close + out.slice(b.index + full.length);
  }
  verifyHtml(html, out, label);
  return out;
}

function verifyHtml(before, after, label) {
  const shape = src => {
    const root = parse(src, {
      comment: false,
      blockTextElements: {
        script: true,
        style: true
      }
    });
    const walk = n => {
      if (n.nodeType === 3) return n.rawText.replace(/\s+/g, " ").trim();
      if (n.nodeType !== 1) return "";
      const attrs = Object.entries(n.attributes).sort().map(([k, v]) => `${k}=${v}`).join("|");
      const kids = /^(script|style)$/i.test(n.rawTagName) ? "" : n.childNodes.map(walk).filter(Boolean).join(">");
      return `${n.rawTagName}[${attrs}](${kids})`;
    };
    return walk(root);
  };
  if (shape(before) !== shape(after)) throw new Error(`${label}: the DOM changed`);
}

(async () => {
  fs.rmSync(OUT, {
    recursive: true,
    force: true
  });
  fs.mkdirSync(OUT, {
    recursive: true
  });
  let saved = 0;
  const report = [];
  for (const f of JS) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    const out = await cleanJs(src, f);
    const written = out.endsWith("\n") ? out : out + "\n";
    fs.writeFileSync(path.join(OUT, f), written);
    saved += src.length - written.length;
    report.push([ f, src.length, written.length ]);
  }
  for (const f of HTML) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    const out = await stripHtml(src, f);
    fs.writeFileSync(path.join(OUT, f), out);
    saved += src.length - out.length;
    report.push([ f, src.length, out.length ]);
  }
  if (fs.existsSync(EDGE_ROOT)) {
    for (const slug of fs.readdirSync(EDGE_ROOT).sort()) {
      const entry = path.join(EDGE_ROOT, slug, "index.ts");
      if (!fs.existsSync(entry)) continue;
      const label = `supabase/functions/${slug}/index.ts`;
      const src = fs.readFileSync(entry, "utf8");
      const out = cleanTs(src, label);
      const dir = path.join(OUT, "supabase", "functions", slug);
      fs.mkdirSync(dir, {
        recursive: true
      });
      fs.writeFileSync(path.join(dir, "index.ts"), out);
      saved += src.length - out.length;
      report.push([ label, src.length, out.length ]);
    }
  }
  for (const f of VERBATIM) {
    const r = resolve(f);
    if (!r) {
      console.warn(`  (skipped: no ${f} in this tree)`);
      continue;
    }
    fs.copyFileSync(path.join(SRC, r.from), path.join(OUT, r.to));
    report.push([ r.from === r.to ? r.to : `${r.from} -> ${r.to}`, null, null ]);
  }
  const w = Math.max(...report.map(r => r[0].length));
  for (const [f, a, b] of report) {
    if (a === null) console.log(`  ${f.padEnd(w)}  copied verbatim`); else console.log(`  ${f.padEnd(w)}  ${String(a).padStart(7)} -> ${String(b).padStart(7)} bytes`);
  }
  console.log(`\n${report.length} files in ${path.basename(OUT)}/. ${saved.toLocaleString()} bytes of comments removed.`);
  console.log("Every file verified equivalent to its commented original.");
})().catch(err => {
  console.error(`\nBUILD FAILED — ${err.message}`);
  console.error(`Nothing in ${path.basename(OUT)}/ should be used until this is resolved.`);
  process.exit(1);
});
