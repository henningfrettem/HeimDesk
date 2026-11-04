// Builds the hosted site (Vercel runs this; see vercel.json) into dist/.
//
// Only the app's own files are copied, by name, so nothing else in the folder
// can end up on the web: not your local config.local.js, not
// todos.json or assets/, not the one-off tools. The site's config.local.js is
// written fresh from environment variables set on the Vercel project:
//
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the publishable (or legacy anon) key
//   SUPABASE_SCHEMA           optional, "heimdesk" by default
//
// The URL and key are public by design: every visitor's browser receives
// them, and the database's row-level security is what keeps data private. The
// build refuses a secret or service_role key, which must never reach a browser.
//
// Run locally:  SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... node deploy/build.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist");
const FILES = [
  "index.html",
  "canvas.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

function fail(msg) {
  console.error("build: " + msg);
  process.exit(1);
}

// A legacy key is a JWT; its middle part says which role it grants.
function jwtRole(key) {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role || null;
  } catch (_) {
    return null;
  }
}

const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
const schema = (process.env.SUPABASE_SCHEMA || "heimdesk").trim();

if (!url || !key) fail("set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the Vercel project.");
if (!/^https:\/\/[^\s/]+$/.test(url)) fail("SUPABASE_URL should look like https://<project>.supabase.co");
if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
  fail("SUPABASE_PUBLISHABLE_KEY is a secret key. Use the publishable key: a secret key must never reach a browser.");
}
if (!key.startsWith("sb_publishable_") && jwtRole(key) !== "anon") {
  fail("SUPABASE_PUBLISHABLE_KEY doesn't look like a publishable key (sb_publishable_...).");
}
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail("SUPABASE_SCHEMA should be a plain schema name, like heimdesk.");

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of FILES) {
  const from = path.join(ROOT, f);
  if (!fs.existsSync(from)) fail("missing " + f);
  fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
  fs.copyFileSync(from, path.join(OUT, f));
}
fs.writeFileSync(path.join(OUT, "config.local.js"),
  "// Written by deploy/build.js from the Vercel project's environment variables.\n"
  + "window.HEIMDESK_CONFIG = " + JSON.stringify({ url, key, schema }, null, 2) + ";\n");

console.log("build: " + (FILES.length + 1) + " files in dist/ for " + url);
