# HeimDesk security guidelines

The policy the security auditor holds every change to, and the monthly full
scan holds the whole app to. A change that breaks a rule marked **must** fails
the audit.

Last reviewed: 2026-11-04, against:

- OWASP Top 10:2025
- OWASP ASVS 5.0.0
- the OWASP Cheat Sheet Series: XSS Prevention, DOM-based XSS, Content
  Security Policy, HTML5 Security, OAuth 2.0, Secrets Management, Logging
- Supabase's security docs: Row Level Security, Securing your API (exposed
  schemas and grants), Storage access control, Realtime authorization, and the
  PKCE flow. Also Supabase's 2026 change, in force on all projects since
  30 October 2026: tables in `public` are no longer exposed to the Data API
  automatically. Custom schemas such as `heimdesk` keep the grants they're
  given, so ours are explicit.

The monthly full scan checks whether any of these has a newer version or new
guidance, and proposes edits to this file when one does.

## What we're protecting, from whom

HeimDesk is a static site: `index.html` and `canvas.js`, served by Vercel, from
a **public** GitHub repository. Every push to `main` deploys. The browser talks
straight to Supabase with the project's publishable key, which every visitor
receives. Row-level security in Postgres and the Storage policies are the only
server-side protection.

The people to defend against:

- **Anyone on the internet.** They have the page, the publishable key and this
  repo.
- **Another signed-in HeimDesk user.** Only the owner signs in today. The data
  model already assumes there could be others, and opening sign-ups must not
  need a redesign.
- **Malicious content.** Text, links or HTML pasted into a card or note from
  somewhere else.
- **Supply chain.** The bundled supabase-js library, and anything else that
  runs in the page.

## Rules

### 1. Secrets and configuration

- No secret **must** ever be committed. That covers a Supabase secret or
  `service_role` key, any JWT, any API token, private keys, database passwords
  and Google OAuth client secrets.
- These files **must** stay gitignored and uncommitted: `config.local.js`,
  `todos.json`, `assets/`, `.security/`, `dist/` and `.env*`.
- This deployment's own details **must** stay out of the repo: the project
  address, the publishable key, the domain name, and anything listed in
  `.security/config.json`.
- Only the publishable key **must** reach the browser. `deploy/build.js`
  refuses a secret key. It copies an explicit list of files and nothing else.
- Session tokens **must not** be logged, put in URLs, or sent anywhere other
  than Supabase.

### 2. The database: Row Level Security and grants (A01 Broken Access Control)

Every table in the `heimdesk` schema:

- **must** have RLS enabled;
- **must** have owner-only policies: `using (user_id = auth.uid()) with check
  (user_id = auth.uid())`, `to authenticated`, with no `using (true)` and no
  policy for `anon`;
- **must** have `user_id uuid not null default auth.uid() references
  auth.users(id) on delete cascade`;
- **must** reference its parent through the owner as well: a composite foreign
  key `(parent_id, user_id) references parent(id, user_id)`, so no row can hang
  off another user's row;
- **must** grant `anon` nothing, and grant `authenticated` only `select,
  insert, update, delete`. No `truncate`, `references` or `trigger`;
- **must** be in the `supabase_realtime` publication if the app syncs it live;
- **must** be added to `supabase/schema.sql` with all of the above, and to
  `supabase/tests/rls_isolation.sql`.

In addition:

- Functions in `heimdesk` **must not** be `security definer`, and **must** have
  `execute` revoked from `public`, `anon` and `authenticated` unless the app
  calls them. One the app calls needs an explicit `search_path` and its own
  `auth.uid()` check.
- No view **must** bypass RLS. Use `security_invoker = on`.
- Only the app's schema **must** be exposed to the Data API. Another schema
  on the same Supabase instance that is exposed **must** have its own
  owner-scoped RLS before sign-ups open: sign-ins are shared across the
  instance.

### 3. Storage (images)

- The bucket **must** be private. Files are reached only through short-lived
  signed URLs.
- Every object path **must** start with the owner's id. The policies **must**
  check `(storage.foldername(name))[1] = auth.uid()::text` for select, insert,
  update (using and with check) and delete, `to authenticated`.
- The bucket **must** have a size limit (10 MB) and allow only `image/png`,
  `image/jpeg`, `image/gif` and `image/webp`. SVG and HTML are never allowed,
  since they can carry script.
- The client **must** check the type and size before uploading, and name the
  file from the checked type, never from the file's own name.

### 4. Rendering user content (A05 Injection, XSS)

Everything a user typed or pasted is untrusted, including their own content,
since it may have been copied from elsewhere.

- It **must** be HTML-escaped, or pass through the app's allowlist sanitizer,
  before reaching `innerHTML`, `insertAdjacentHTML`, `outerHTML` or
  `document.write`.
- Pasted HTML **must** be sanitized to the allowlist, never inserted raw.
- Links **must** allow only `http:`, `https:` and `mailto:`, plus the app's own
  `#card=`/`#note=`/`#entry=` links. Never `javascript:`, `data:` or `vbscript:`.
- Images **must** allow only `sb:` references, `https:` and `data:` URLs, and
  only ever as an `<img>` source, never as a link target.
- External links **must** have `rel="noopener noreferrer"`.
- Nothing **must** reach `eval`, `new Function`, `setTimeout` with a string,
  or inline event handlers built from data.
- Drawing data (`canvas.js`) **must** be normalized and treated as data. Text in
  a drawing is set with `textContent`, never parsed as markup.

### 5. Authentication (A07)

- Sign-in **must** be Google through Supabase with PKCE. No implicit flow, and
  no tokens in the address bar.
- `redirectTo` **must** be the app's own origin and path. No redirect target
  **must** be taken from the URL, the hash or stored content.
- Error parameters from a failed sign-in are shown as text and then removed
  from the address.
- Signing out **must** flush pending saves and end the session.

### 6. Browser hardening (A02 Security Misconfiguration)

- `vercel.json` **must** keep: `Content-Security-Policy: frame-ancestors
  'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  and `X-Robots-Tag: noindex, nofollow`. HSTS comes from Vercel.
- A change that adds a script, style, font, frame or connection to a new
  origin **must** be called out.
- A full `Content-Security-Policy` (script-src etc.) is a recommended next step
  that the full scan tracks.
- `localStorage`/`sessionStorage` **must not** hold anything beyond
  preferences, the pending link and supabase-js's own session.

### 7. Supply chain (A03 Software Supply Chain Failures)

- Third-party code **must** be vendored into the repo, at a known version, or
  loaded from a pinned exact version with Subresource Integrity.
- The bundled supabase-js version (2.116.0 at the last review) is checked
  against published advisories on every full scan.
- No build step **must** pull packages at deploy time. `deploy/build.js` uses
  Node's standard library only.

### 8. Errors and data safety (A10 Mishandling of Exceptional Conditions, A08)

- A failed save **must** keep the change and retry, never drop it.
- Error messages shown to the user **must not** include tokens or keys.
- A schema change **must** be backwards compatible with the deployed app, or
  ship as an idempotent, transactional migration. It **must** check its own
  result and say in which order to apply it relative to the deploy. A change
  that could lose or orphan existing data fails the audit.

### 9. Privacy

- No analytics, trackers or third-party beacons.
- No user content or personal data in URLs, query strings or logs. Item ids
  in `#card=` links are fine.

### 10. The security tooling itself

Everything that makes up the gate:

- `scripts/security/`, `.githooks/` (the templates `gate.mjs init` installs
  into `.git/hooks`), `.claude/settings.json`;
- `.claude/agents/security-*.md`, this file, and `CLAUDE.md`;
- `.gitignore`, `.vercelignore`, `deploy/build.js`, and the headers in
  `vercel.json`.

Any change to these that weakens a check, widens what can be committed, or
lets something skip the audit fails, unless the owner has asked for that
change in so many words.

## Accepted risks

These are known and documented. They are not findings, unless a change makes
them worse.

- **Realtime deletes.** Under RLS, every subscriber to the schema receives the
  primary key of any deleted row, but no content. The app ignores ids it
  doesn't hold. This is accepted while HeimDesk has one user. It **must** be
  fixed before sign-ups open, with per-user channels: Realtime Broadcast with
  authorization.
- **"Private" cards and notes.** The private flag blurs them on screen. It does
  not encrypt them, and the README says so.
- **Signed image URLs.** They work for an hour for anyone who has the link.
- **Sessions.** The session lives in `localStorage`, as supabase-js keeps it.
  Any XSS would expose it, which is why rule 4 is strict.
- **What a local gate can and can't stop.** See "The gate's limits", below.

## The gate's limits

The gate runs on the owner's machine, as the owner's user, next to an agent
that has a shell. It is built so that nothing it relies on can be changed
without going through it:

- **What runs it is out of reach.**
  - The hooks git runs live in `.git/hooks`, outside the working tree.
  - Both they and the Claude Code hooks run `gate.mjs` as it was last
    committed, so as already audited, never the working tree's copy. An edit
    to the gate does nothing until it has been approved and committed.
  - The Claude Code settings that start the guard can only be changed by the
    owner, by hand.
- **The guard closes the direct ways around it.** It sees through quoting,
  `$(...)`, backticks, subshells, `eval`/`bash -c`, and abbreviated or aliased
  flags, and through the directory a command runs in. It blocks:
  - flags that skip the hooks, and settings that move them;
  - shell commands that touch `.git` or `.security`;
  - edits to `.git`, to the settings, and to approvals, reports and the scan
    date;
  - recording an approval by anyone but the auditors, and any write by the
    auditors except their report.

What no local check can rule out is a deliberate, roundabout route by the
same user: a script written in one step and run in another, values
assembled at run time, a link made earlier. The gate is there to stop
mistakes, forgetting, and instructions injected through content. It is not a
sandbox against an agent determined to get around it; such an attempt also
shows in the session transcript.

So the auditors report:

- any single command, together with the directory it runs in, that gets past
  the guard;
- any way an uncommitted change alters what the hooks or the guard run;
- anything that lets the gate's own files be changed without an audit.

A multi-step route through files, links or run-time values is this accepted
risk, not a finding.

## Before sign-ups are opened to anyone

Each of these blocks opening sign-ups:

1. The realtime-deletes fix above.
2. Exposed schemas: confirm that every other exposed schema on the instance
   has owner-scoped RLS (rule 2).
3. Supabase's Email provider is off, so Google is the only way in.
4. A privacy policy and terms, Supabase's data processing agreement, and an
   in-app way to delete your account. Deleting an account must also remove
   that user's images from Storage.
5. Backups on a paid plan, and a staging project to test migrations on.
6. A full scan with a PASS, run after all of the above.
