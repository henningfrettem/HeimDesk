#!/usr/bin/env node
// HeimDesk's security gate: what git and Claude Code run before anything is
// committed or pushed, and so before anything is deployed (every push to main
// goes live). security/GUIDELINES.md is the policy; README, "Security
// checks", says how the pieces fit together.
//
//   node scripts/security/gate.mjs init            install the git hooks (once per clone)
//   node scripts/security/gate.mjs status          what's staged, approved and due
//   node scripts/security/gate.mjs check-staged    the fixed checks, on what's staged
//   node scripts/security/gate.mjs check-all       the fixed checks, on every tracked file
//   node scripts/security/gate.mjs probe-live      read-only checks of the live site
//   node scripts/security/gate.mjs approve --report <file>           security-auditor only
//   node scripts/security/gate.mjs record-full-scan --report <file>  security-full-scan only
//
// and, from hooks: pre-commit, pre-push, claude-guard, claude-session-start.
//
// The hooks don't run this file from the working tree. They run it as it was
// last committed, and so already audited (see .githooks/ and
// .claude/settings.json), so an edit to it does nothing until it's been
// approved and committed. The hooks git runs are installed in .git/hooks, out
// of the working tree.
//
// Approvals, reports and the monthly-scan date live in .security/, which is
// gitignored: the repo is public, and an audit report is a map of weaknesses.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import dns from "node:dns";
import { fileURLToPath } from "node:url";

// Run from a copy (see above), it's told where the repository is.
const ROOT = process.env.HEIMDESK_GATE_ROOT
  ? path.resolve(process.env.HEIMDESK_GATE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEC = path.join(ROOT, ".security");
const APPROVALS = path.join(SEC, "approvals");
const REPORTS = path.join(SEC, "reports");
const STATE = path.join(SEC, "state.json");
const LOCAL_CONFIG = path.join(SEC, "config.json");

const AUDITORS = ["security-auditor", "security-full-scan"];
const FULL_SCAN_EVERY_DAYS = 30;
// After a full scan falls due, commits still go through for this long (with a
// reminder each time); after that the gate holds everything until it's run.
const FULL_SCAN_GRACE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

const TABLES = ["folders", "categories", "tasks", "checklist_items", "note_categories", "notes", "note_entries"];

// Files that must never be committed. The repo is public.
const FORBIDDEN_PATHS = [
  [/^config\.local\.js$/i, "the local Supabase config"],
  [/(^|\/)todos\.json$/i, "the old local data file"],
  [/^assets\//i, "the old local images"],
  [/^\.security\//i, "security approvals and reports"],
  [/^dist\//i, "build output"],
  [/(^|\/)\.env($|\.)/i, "an environment file"],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, "a key file"],
  [/(^|\/)\.vercel\//i, "Vercel's local project link"],
  [/^supabase-check\.html$/i, "a local debugging page"]
];

// Things that look like credentials, or like this deployment's own details.
// The publishable key and project address are public on the live site, but
// they're configuration and stay out of the repo.
const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{8,}/, "a Supabase secret key"],
  [/sb_publishable_[A-Za-z0-9_-]{16,}/, "a Supabase publishable key (it belongs in config.local.js or on Vercel)"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JWT (a legacy Supabase key or a session token)"],
  [/https?:\/\/[a-z0-9]{20}\.supabase\.(co|in)\b/i, "a real Supabase project address"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, "a Google OAuth client secret"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{40,}/, "an API secret key"],
  [/\bpostgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i, "a database address with a password in it"]
];

// .gitignore has to keep ignoring these.
const MUST_IGNORE = ["config.local.js", "todos.json", "assets/", ".security/", "dist/"];

/* ---------- small helpers ---------- */

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 });
}
function gitBuffer(...args) {
  return execFileSync("git", args, { cwd: ROOT, maxBuffer: 256 << 20 });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function localConfig() {
  return readJson(LOCAL_CONFIG, {});
}
function stagedTree() {
  return git("write-tree").trim();
}
function rel(p) {
  return path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join("/");
}
function fail(lines) {
  console.error(["", "HeimDesk security gate:", ...lines, ""].join("\n"));
  process.exit(1);
}
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/* ---------- the monthly full scan ---------- */

function fullScanStatus(now = Date.now()) {
  const state = readJson(STATE, {});
  const last = state.lastFullScan && Date.parse(state.lastFullScan.date);
  const base = last || Date.parse(state.initializedAt || "") || now;
  const due = base + FULL_SCAN_EVERY_DAYS * DAY;
  return {
    last: last ? state.lastFullScan : null,
    due,
    isDue: now >= due,
    blocked: now >= due + FULL_SCAN_GRACE_DAYS * DAY,
    blockedFrom: due + FULL_SCAN_GRACE_DAYS * DAY
  };
}
function fullScanLines(s) {
  const last = s.last ? `last ${s.last.date.slice(0, 10)} (${s.last.verdict})` : "never run";
  if (s.blocked) return [`The monthly full security scan is overdue (${last}).`,
    "Nothing can be committed or pushed until the security-full-scan agent has run."];
  if (s.isDue) return [`Reminder: the monthly full security scan is due (${last}).`,
    `Run the security-full-scan agent. From ${fmtDate(s.blockedFrom)} the gate holds commits until it has.`];
  return [];
}

/* ---------- the fixed checks ---------- */

function scanText(file, text, findings, extraStrings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 20000) line = line.slice(0, 20000); // minified library code
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: looks like ${what}`);
    }
    const lower = line.toLowerCase();
    for (const s of extraStrings) {
      if (lower.includes(s)) findings.push(`${file}:${i + 1}: contains "${s}", listed in .security/config.json as not for the public repo`);
    }
  });
}

function checkPath(file, findings) {
  for (const [re, what] of FORBIDDEN_PATHS) {
    if (re.test(file)) findings.push(`${file}: is ${what}, which must never be committed`);
  }
}

function checkGitignore(text, findings) {
  const lines = new Set(text.split(/\r?\n/).map(l => l.trim()));
  for (const p of MUST_IGNORE) {
    if (!lines.has(p) && !lines.has("/" + p)) findings.push(`.gitignore: no longer ignores ${p}`);
  }
}

function extraStrings() {
  return (localConfig().forbiddenStrings || []).map(s => String(s).toLowerCase()).filter(Boolean);
}

// What's staged: every added, changed, copied or renamed file, as it's staged.
function checkStaged() {
  const findings = [];
  const strings = extraStrings();
  const out = git("diff", "--cached", "--name-status", "-z", "--no-renames");
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i], file = parts[i + 1];
    if (status === "D") continue;
    checkPath(file, findings);
    const blob = gitBuffer("show", ":" + file);
    if (blob.length > 16 << 20 || blob.includes(0)) continue; // binary
    scanText(file, blob.toString("utf8"), findings, strings);
  }
  checkGitignore(gitBuffer("show", ":.gitignore").toString("utf8"), findings);
  return findings;
}

// Everything tracked, as it's staged (for the full scan, and to calibrate).
function checkAll() {
  const findings = [];
  const strings = extraStrings();
  for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
    checkPath(file, findings);
    let blob;
    try { blob = gitBuffer("show", ":" + file); } catch { continue; }
    if (blob.length > 16 << 20 || blob.includes(0)) continue;
    scanText(file, blob.toString("utf8"), findings, strings);
  }
  checkGitignore(gitBuffer("show", ":.gitignore").toString("utf8"), findings);
  return findings;
}

/* ---------- approvals ---------- */

function approvalFor(tree) {
  return readJson(path.join(APPROVALS, tree + ".json"), null);
}

function readReport(file) {
  if (!file) fail(["--report <file> is required."]);
  const full = path.resolve(ROOT, file);
  if (!rel(full).startsWith(".security/reports/")) fail(["Reports go in .security/reports/."]);
  if (!fs.existsSync(full)) fail([`No report at ${rel(full)}.`]);
  return { full, text: fs.readFileSync(full, "utf8") };
}

function approve() {
  const { full, text } = readReport(arg("--report"));
  const tree = stagedTree();
  if (!new RegExp(`^Tree:\\s*${tree}\\s*$`, "m").test(text)) {
    fail([`The report doesn't name the staged tree (${tree}).`,
      "What's staged changed after the audit, or the report is for something else. Audit again."]);
  }
  if (!/^Verdict:\s*PASS\s*$/m.test(text)) fail(["The report's verdict isn't PASS, so nothing is approved."]);
  const findings = checkStaged();
  if (findings.length) fail(["The fixed checks still fail:", ...findings.map(f => "  " + f)]);
  writeJson(path.join(APPROVALS, tree + ".json"), {
    tree, report: rel(full), approvedAt: new Date().toISOString()
  });
  console.log(`Approved tree ${tree} (report ${rel(full)}).`);
}

function recordFullScan() {
  const { full, text } = readReport(arg("--report"));
  if (!/^Type:\s*full-scan\s*$/m.test(text)) fail(["That isn't a full-scan report (no \"Type: full-scan\" line)."]);
  const verdict = (/^Verdict:\s*(PASS|FAIL)\s*$/m.exec(text) || [])[1];
  if (!verdict) fail(["The report has no \"Verdict: PASS\" or \"Verdict: FAIL\" line."]);
  const state = readJson(STATE, {});
  state.lastFullScan = { date: new Date().toISOString(), verdict, report: rel(full) };
  writeJson(STATE, state);
  console.log(`Recorded the full scan: ${verdict}. Next one due ${fmtDate(fullScanStatus().due)}.`);
}

/* ---------- git hooks ---------- */

function preCommit() {
  const findings = checkStaged();
  if (findings.length) {
    fail(["The fixed checks found something that must not be committed:",
      ...findings.map(f => "  " + f), "Unstage or fix it, then audit again."]);
  }
  const scan = fullScanStatus();
  if (scan.blocked) fail(fullScanLines(scan));
  const tree = stagedTree();
  if (!approvalFor(tree)) {
    fail(["What's staged hasn't been approved by the security auditor.",
      `  staged tree ${tree}`,
      "In Claude Code, have the security-auditor agent audit the staged changes,",
      "then commit without changing what's staged."]);
  }
  for (const line of fullScanLines(scan)) console.error(line);
}

function prePush(stdin) {
  const ZERO = /^0+$/;
  const problems = [];
  for (const line of stdin.split(/\r?\n/).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleting a branch
    const range = ZERO.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    for (const commit of git("rev-list", ...range).split("\n").filter(Boolean)) {
      const tree = git("rev-parse", commit + "^{tree}").trim();
      if (!approvalFor(tree)) problems.push(`  ${commit.slice(0, 10)} ${git("log", "-1", "--format=%s", commit).trim()}`);
    }
  }
  if (problems.length) {
    fail(["These commits were never approved by the security auditor, so they can't be pushed (or deployed):",
      ...problems, "Audit them first (the security-auditor agent), or take them out of the push."]);
  }
  const scan = fullScanStatus();
  if (scan.blocked) fail(fullScanLines(scan));
  const state = readJson(STATE, {});
  if (state.lastFullScan && state.lastFullScan.verdict === "FAIL") {
    console.error(`Warning: the last full scan (${state.lastFullScan.date.slice(0, 10)}) failed. ` +
      `Its findings are in ${state.lastFullScan.report}.`);
  }
  for (const line of fullScanLines(scan)) console.error(line);
}

/* ---------- Claude Code hooks ---------- */

// Heredoc bodies taken out, so a commit message written in one can't trip the
// checks below.
function withoutHeredocs(cmd) {
  return cmd
    .replace(/<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, " ")
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, " ");
}
// Quoted strings taken out entirely: what's left is what the shell acts on
// unquoted, such as redirections.
function withoutQuotes(cmd) {
  return cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ");
}
// The command line as the shell splits it: quotes joined up and removed, so
// --no-"verify" is seen as --no-verify, while a quoted commit message stays one
// word. Unquoted ; | & ( ) ` and newlines end a command, so one inside $(...),
// `...` or a subshell counts as a command of its own. Each command is a list
// of words.
function splitCommands(cmd) {
  const commands = [[]];
  let word = null;
  const end = () => { if (word !== null) commands[commands.length - 1].push(word); word = null; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      word = (word || "") + cmd.slice(i + 1, j < 0 ? cmd.length : j);
      i = j < 0 ? cmd.length : j;
    } else if (c === '"') {
      let s = "";
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === "\\" && i + 1 < cmd.length) i++;
        s += cmd[i];
      }
      word = (word || "") + s;
    } else if (c === "\\" && i + 1 < cmd.length && cmd[i + 1] !== "\n") {
      word = (word || "") + cmd[++i];
    } else if (/[;|&\n()`]/.test(c)) {
      end();
      if (commands[commands.length - 1].length) commands.push([]);
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word || "") + c;
    }
  }
  end();
  return commands.filter(c => c.length);
}
// A quoted string can be run as a command too: by eval, bash -c,
// Invoke-Expression, or as a $(...) inside double quotes. So any word that
// could hold a command line is read as one as well. A commit message that
// spells out a forbidden command is refused with it, which is a fair price.
function shellCommands(cmd, depth = 0) {
  const commands = splitCommands(cmd);
  if (depth >= 3) return commands;
  const inner = commands.flat().filter(w => /[\s;|&()`$]/.test(w)).flatMap(w => shellCommands(w, depth + 1));
  return commands.concat(inner);
}
// Each git invocation in a command line: its subcommand and the words after it.
function gitCalls(commands) {
  const calls = [];
  for (const words of commands) {
    let i = words.findIndex(w => /(^|[\\/$({`])git(\.exe)?$/i.test(w));
    if (i < 0) continue;
    i++;
    while (i < words.length && words[i].startsWith("-")) {
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[i])) i++;
      i++;
    }
    if (i < words.length) calls.push({ sub: words[i], args: words.slice(i + 1) });
  }
  return calls;
}
// git commit's short options cluster (-am), and one that takes a value takes
// the rest of the word (-mfoo), so -n counts only before such an option.
function skipsHooks(word) {
  if (!/^-[^-]/.test(word)) return false;
  for (const ch of word.slice(1)) {
    if (ch === "n") return true;
    if ("mFCctSu".includes(ch)) return false;
  }
  return false;
}

const GIT_WRITES = new Set(["commit", "push", "add", "rm", "mv", "reset", "checkout", "switch", "restore",
  "stash", "merge", "rebase", "cherry-pick", "revert", "tag", "branch", "clean", "apply", "am", "config",
  "update-ref", "update-index", "gc", "prune", "worktree", "submodule", "notes", "replace", "filter-branch"]);
const WRITE_COMMANDS = /^(rm|rmdir|del|erase|mv|move|cp|copy|tee|truncate|touch|ln|chmod|dd|install|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Content|Add-Content|Out-File|New-Item|Clear-Content|Set-ItemProperty)$/i;
const INLINE_CODE = { node: ["-e", "--eval", "-p", "--print"], python: ["-c"], python3: ["-c"], py: ["-c"],
  bash: ["-c"], sh: ["-c"], zsh: ["-c"], perl: ["-e", "-E"], ruby: ["-e"],
  powershell: ["-c", "-command", "-encodedcommand", "-e", "-ec"], pwsh: ["-c", "-command", "-encodedcommand", "-e", "-ec"] };
// An unquoted > or >> that writes to a file: not 2> (errors), not >&2, and
// not into the null device.
const REDIRECT = /(^|[^2>])>{1,2}(?!&)(?!\s*(\/dev\/null|\$null|nul)\b)/i;
// Commands that run the command after them.
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "xargs", "exec", "nice", "timeout", "busybox"]);

function guardShell(command, agent, cwd) {
  const isAuditor = AUDITORS.includes(agent);
  const raw = withoutHeredocs(command);
  const commands = shellCommands(raw);
  const words = commands.flat();
  const text = (raw + " " + words.join(" ")).toLowerCase();

  // Where the command runs counts as much as what it says: "cd .security" in
  // one command and a write to "approvals/" in the next is the same as one.
  const here = cwd ? rel(cwd).toLowerCase() : "";
  if (here === ".git" || here.startsWith(".git/")) return "Run commands from the project folder, not inside .git.";
  if (here === ".security" || here.startsWith(".security/")) return "Run commands from the project folder, not inside .security.";
  // The hooks git runs, and the copies of the gate they run, are in .git.
  // Shell commands stay out of it altogether (git itself is fine).
  if (/(^|[^\w.-])\.git([\\/"'\s]|$)/.test(text)) {
    return "Shell commands don't touch .git: the security hooks live there. Use git itself.";
  }
  // The approvals and the scan date are in .security, written only by this
  // gate. Read reports with the Read tool and edit config.json with Edit;
  // shell commands don't name the folder at all (the auditors may, to pass
  // their report to approve, and they can't write).
  if (text.includes(".security") && (!isAuditor || /approvals|state\.json/.test(text))) {
    return "Shell commands don't touch .security: use the Read tool for reports and Edit for config.json.";
  }

  // A setting that moves the hooks away, however it's quoted or passed: a
  // config key, -c, --config-env or a GIT_CONFIG_* variable. A word with spaces
  // in it is prose, such as a commit message.
  if (words.some(w => /core\.hookspath/i.test(w) && !/\s/.test(w))) {
    return "The git hooks are the security gate; changing core.hooksPath is not allowed.";
  }
  // Git accepts any unambiguous start of a long option, so --no-veri is enough.
  if (words.some(w => /(^|\s|=)--no-veri/.test(w))) {
    return "Skipping the git hooks (--no-verify) is not allowed: they are the security gate.";
  }
  // An alias could carry -n or --no-verify where these checks don't look.
  if (words.some(w => /^alias\./i.test(w) && !/\s/.test(w))) {
    return "Defining git aliases is not allowed here: one could skip the hooks.";
  }
  for (const { sub, args } of gitCalls(commands)) {
    if (sub === "commit" && args.some(skipsHooks)) {
      return "git commit -n skips the git hooks, which are the security gate. Commit without it.";
    }
    if (isAuditor && GIT_WRITES.has(sub)) return `The security auditor only reads: git ${sub} is not allowed for it.`;
  }
  const verbs = commands.flatMap(ws => ws.flatMap((w, i) => /gate\.mjs$/i.test(w) && ws[i + 1] ? [ws[i + 1]] : []));
  if (verbs.includes("approve") && !isAuditor) {
    return "Only the security-auditor (or security-full-scan) agent can approve. Run the security-auditor agent on the staged changes.";
  }
  if (verbs.includes("record-full-scan") && agent !== "security-full-scan") {
    return "Only the security-full-scan agent can record a full scan.";
  }
  if (isAuditor) {
    const writes = commands.some(all => {
      // Past variable assignments (X=1 cmd) and wrappers (xargs cmd).
      let k = 0;
      const nameAt = j => (all[j] || "").split(/[\\/]/).pop().replace(/\.exe$/i, "").toLowerCase();
      while (k < all.length && (/^[A-Za-z_]\w*=/.test(all[k]) || WRAPPERS.has(nameAt(k)) || (k > 0 && all[k].startsWith("-")))) k++;
      const ws = all.slice(k);
      if (!ws.length) return false;
      const name = nameAt(k);
      if (WRITE_COMMANDS.test(name)) return true;
      if (name === "find" && ws.some(w => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w))) return true;
      if (name === "sed" && ws.some(w => /^-[a-z]*i/.test(w) || w.startsWith("--in-place"))) return true;
      return (INLINE_CODE[name] || []).some(flag => ws.slice(1).some(w => w.toLowerCase() === flag));
    });
    if (writes || REDIRECT.test(withoutQuotes(raw)) || /\[(System\.)?IO\.(File|Directory)\]::/i.test(raw)) {
      return "The security auditor only reads. Write the report with the Write tool, in .security/reports/.";
    }
  }
  return null;
}

function guardWrite(file, agent) {
  if (!file) return null;
  const r = rel(file).toLowerCase();
  if (AUDITORS.includes(agent)) {
    if (r.startsWith(".security/reports/") && r.endsWith(".md") && !r.slice(18).includes("/")) return null;
    return "The security auditor doesn't change files. Its report goes in .security/reports/, as a .md file.";
  }
  if (r === ".git" || r.startsWith(".git/")) return "Nothing is written into .git by hand: `gate.mjs init` installs the hooks there.";
  if (r === ".claude/settings.json" || r === ".claude/settings.local.json") {
    return "These settings run the security guard, so the owner changes them by hand.";
  }
  if (r.startsWith(".security/") && r !== ".security/config.json") {
    return "Approvals, reports and the scan date are written only by the gate and the auditors.";
  }
  return null;
}

function claudeGuard(stdin) {
  let input;
  try { input = JSON.parse(stdin); } catch { return; }
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const agent = input.agent_type || "";
  let reason = null;
  if (tool === "Bash" || tool === "PowerShell") reason = guardShell(String(ti.command || ""), agent, input.cwd);
  else if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) reason = guardWrite(ti.file_path || ti.notebook_path, agent);
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }
    }));
  }
}

function hooksDir() {
  return path.resolve(ROOT, git("rev-parse", "--git-path", "hooks").trim());
}
// Installed in .git/hooks (where git looks by default), and nothing pointing
// git somewhere else.
function hooksOn() {
  let custom = "";
  try { custom = git("config", "--get", "core.hooksPath").trim(); } catch {}
  if (custom) return false;
  return ["pre-commit", "pre-push"].every(h => {
    try { return fs.readFileSync(path.join(hooksDir(), h), "utf8").includes("HeimDesk security gate"); } catch { return false; }
  });
}

function claudeSessionStart() {
  const lines = [
    "HeimDesk security gate: before every commit, stage the change and have the security-auditor agent audit it;",
    "only its PASS lets git commit and push (and every push to main deploys). Never bypass the git hooks."
  ];
  if (!hooksOn()) lines.push("The git hooks are OFF in this clone: run `node scripts/security/gate.mjs init` first.");
  lines.push(...fullScanLines(fullScanStatus()));
  const state = readJson(STATE, {});
  if (state.lastFullScan && state.lastFullScan.verdict === "FAIL") {
    lines.push(`The last full scan failed; its findings are in ${state.lastFullScan.report}.`);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") }
  }));
}

/* ---------- setup and status ---------- */

function init() {
  // Earlier clones pointed git at .githooks in the working tree, where an edit
  // would take effect at once.
  try { git("config", "--unset", "core.hooksPath"); } catch {}
  const dir = hooksDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const h of ["pre-commit", "pre-push"]) {
    fs.copyFileSync(path.join(ROOT, ".githooks", h), path.join(dir, h));
    fs.chmodSync(path.join(dir, h), 0o755);
  }
  fs.mkdirSync(APPROVALS, { recursive: true });
  fs.mkdirSync(REPORTS, { recursive: true });
  const state = readJson(STATE, {});
  if (!state.initializedAt) {
    // A first full scan falls due straight away: there's no baseline yet.
    state.initializedAt = new Date(Date.now() - FULL_SCAN_EVERY_DAYS * DAY).toISOString();
    writeJson(STATE, state);
  }
  if (!fs.existsSync(LOCAL_CONFIG)) {
    writeJson(LOCAL_CONFIG, {
      liveUrl: "",
      forbiddenStrings: []
    });
  }
  console.log("Git hooks installed in .git/hooks; they run the gate as last committed. Local state in .security/ (gitignored).");
  if (!localConfig().liveUrl) console.log("Fill in .security/config.json: liveUrl, and forbiddenStrings for the public repo.");
}

function status() {
  const tree = stagedTree();
  const staged = git("diff", "--cached", "--name-only").trim();
  console.log(`Git hooks: ${hooksOn() ? "on" : "OFF (run init)"}`);
  console.log(`Staged tree: ${tree}${staged ? "" : " (nothing staged)"}`);
  const a = approvalFor(tree);
  console.log(`Approved: ${a ? `yes, ${a.approvedAt.slice(0, 16)} (${a.report})` : "no"}`);
  const s = fullScanStatus();
  console.log(`Full scan: ${s.last ? `last ${s.last.date.slice(0, 10)}, ${s.last.verdict}` : "never run"}; ` +
    `due ${fmtDate(s.due)}${s.blocked ? " (OVERDUE: commits are held)" : s.isDue ? " (DUE NOW)" : ""}`);
}

/* ---------- read-only checks of the live site ---------- */

// The machine's own resolver doesn't always know a freshly added name, so
// fall back to asking Cloudflare's resolver over HTTPS.
function lookup(host, opts, cb) {
  dns.lookup(host, { family: 4 }, (err, address, family) => {
    if (!err) return cb(null, address, family);
    https.get(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`,
      { headers: { accept: "application/dns-json" } }, res => {
        let body = "";
        res.on("data", c => (body += c));
        res.on("end", () => {
          try {
            const ans = (JSON.parse(body).Answer || []).find(a => a.type === 1);
            if (ans) return cb(null, ans.data, 4);
          } catch {}
          cb(err);
        });
      }).on("error", () => cb(err));
  });
}
function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, lookup: (h, o, cb) => lookup(h, o, (e, a, f) => {
      if (e) return cb(e);
      if (o && o.all) return cb(null, [{ address: a, family: f }]);
      cb(null, a, f);
    }) }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function probeLive() {
  const base = (localConfig().liveUrl || "").replace(/\/+$/, "");
  if (!base) fail(["Set liveUrl in .security/config.json first."]);
  const results = [];
  const ok = (cond, what) => results.push(`${cond ? "PASS" : "FAIL"}  ${what}`);

  const page = await request(base + "/");
  const h = page.headers;
  ok(page.status === 200, `the page loads (${page.status})`);
  ok(/frame-ancestors\s+'none'/.test(h["content-security-policy"] || ""), "CSP frame-ancestors 'none'");
  ok((h["x-content-type-options"] || "") === "nosniff", "X-Content-Type-Options: nosniff");
  ok((h["referrer-policy"] || "") === "no-referrer", "Referrer-Policy: no-referrer");
  ok(/noindex/.test(h["x-robots-tag"] || ""), "X-Robots-Tag: noindex");
  ok(/max-age=\d{7,}/.test(h["strict-transport-security"] || ""), "Strict-Transport-Security");

  const conf = await request(base + "/config.local.js");
  let cfg = null;
  try { cfg = JSON.parse(conf.body.slice(conf.body.indexOf("{"), conf.body.lastIndexOf("}") + 1)); } catch {}
  ok(!!(cfg && cfg.url && cfg.key), "the site's config.local.js has a project address and key");
  if (!cfg) return report(results);
  const legacyRole = (() => {
    try { return JSON.parse(Buffer.from(cfg.key.split(".")[1], "base64url").toString()).role; } catch { return null; }
  })();
  ok(cfg.key.startsWith("sb_publishable_") || legacyRole === "anon", "the key in it is a publishable key, not a secret one");
  for (const f of ["config.local.example.js", "README.md", "supabase/schema.sql", "scripts/security/gate.mjs", ".security/state.json", "todos.json", ".git/config"]) {
    const r = await request(base + "/" + f);
    ok(r.status === 404, `${f} isn't served (${r.status})`);
  }

  const schema = cfg.schema || "heimdesk";
  const anon = { apikey: cfg.key, Authorization: "Bearer " + cfg.key, "Accept-Profile": schema };
  for (const t of TABLES) {
    const r = await request(`${cfg.url}/rest/v1/${t}?select=id&limit=1`, { headers: anon });
    let rows = null;
    try { rows = JSON.parse(r.body); } catch {}
    const denied = r.status === 401 || r.status === 403;
    const empty = r.status === 200 && Array.isArray(rows) && rows.length === 0;
    ok(denied || empty, `signed out, ${schema}.${t} gives nothing (${r.status}${empty ? ", empty" : ""})`);
    if (empty) results.push(`NOTE  signed out, ${schema}.${t} is still queryable (RLS hides every row); anon should have no grants`);
  }
  const list = await request(`${cfg.url}/storage/v1/object/list/todo-images`, {
    method: "POST", headers: { apikey: cfg.key, Authorization: "Bearer " + cfg.key, "content-type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 5 })
  });
  let items = null;
  try { items = JSON.parse(list.body); } catch {}
  ok(!(Array.isArray(items) && items.length), `signed out, the image bucket lists nothing (${list.status})`);
  return report(results);
}
function report(results) {
  console.log(results.join("\n"));
  if (results.some(r => r.startsWith("FAIL"))) process.exit(1);
}

/* ---------- main ---------- */

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

const cmd = process.argv[2];
try {
  switch (cmd) {
    case "init": init(); break;
    case "status": status(); break;
    case "check-staged":
    case "check-all": {
      const findings = cmd === "check-all" ? checkAll() : checkStaged();
      if (findings.length) fail(["The fixed checks found:", ...findings.map(f => "  " + f)]);
      console.log("The fixed checks pass.");
      break;
    }
    case "approve": approve(); break;
    case "record-full-scan": recordFullScan(); break;
    case "pre-commit": preCommit(); break;
    case "pre-push": prePush(readStdin()); break;
    case "claude-guard": claudeGuard(readStdin()); break;
    case "claude-session-start": claudeSessionStart(); break;
    case "probe-live": await probeLive(); break;
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).join("\n"));
  }
} catch (e) {
  // A hook that can't run its checks holds the commit rather than waving it
  // through; the Claude Code guard is the exception, so a bug in it can't
  // wedge the session.
  if (cmd === "claude-guard" || cmd === "claude-session-start") process.exit(0);
  fail([String(e && e.stack || e)]);
}
