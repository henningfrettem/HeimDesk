# Working on HeimDesk

- **Every push to `main` deploys to production**, and the app holds real data.
  Test thoroughly before pushing.
- **The repository is public.** Never commit `config.local.js`, `todos.json`,
  `assets/`, `.security/` or `dist/`. Never commit secrets, the Supabase project
  address or key, or the site's domain name. Never use or ship a Supabase
  secret or `service_role` key.
- **Security gate.** Before every commit:
  1. Stage exactly what will be committed.
  2. Have the `security-auditor` agent audit it.
  3. Only after its PASS, commit, without changing what's staged.

  The git hooks refuse anything unapproved, and refuse pushes of unapproved
  commits. `node scripts/security/gate.mjs init` installs them from
  `.githooks/` into `.git/hooks`, and they run the gate as last committed.
  Never get around them: no `--no-verify`, no changes to `core.hooksPath`, no
  touching `.git` or `.security` from the shell. If the auditor fails a change,
  fix the findings and audit again.
- **The Claude Code settings** (`.claude/settings.json`) run the guard, so only
  the owner changes them, by hand.
- **Monthly full scan.** When the gate or the session reminder says the full
  scan is due, run the `security-full-scan` agent. It runs on the most capable
  model and records the scan date.
- **No connectors for the security agents.** Start them so that none of the
  account's connectors load, e.g. from a terminal:
  `claude -p "<what to audit>" --agent security-auditor --strict-mcp-config`.
- **Policy.** The policy is `security/GUIDELINES.md`.
- **No breaking changes without a migration.** A schema change ships in
  `supabase/schema.sql`, which must stay safe to re-run, and must work with the
  deployed app or come with a clear order of steps.
- **Phone and touch changes** stay in their media layers. Prove the desktop is
  unchanged with a layout diff.
