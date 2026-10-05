# Todo

A single-file todo board with a notes pane, backed by Supabase. The whole app is
`index.html`, plus `canvas.js` for drawings, served as a static site (on Vercel,
for instance) and installable as an app. You sign in with Google.

## Running it

The app runs from a web address, because signing in goes through Google, and
Google has to send the browser back to one. So it's hosted (see *Hosting it*
below), or, while working on it, served from this folder on your own machine:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. For sign-in to work there, add
`http://localhost:8000/**` to Supabase's Redirect URLs, next to the hosted
address. Opened straight from disk (`file://`), the page loads but explains
that it can't sign in, instead of offering the button.

Without a config, the first launch asks for your Supabase **project URL** and
**publishable key** and keeps them in `localStorage`. To skip that, copy
`config.local.example.js` to **`config.local.js`** and fill it in. That file is
gitignored and wins over anything typed on screen; the hosted site gets its own,
written by the build. supabase-js keeps the session, so you sign in once per
browser.

**The app needs an internet connection.** There is no offline mode: without a
route to Supabase it cannot load your board.

## Installing it

From the hosted site, Chrome and Edge show an install icon at the right end of
the address bar (or **⋮ → Cast, save and share → Install page as app…**). The
app then opens in its own window, with its own taskbar and Alt-Tab entry;
right-click the taskbar icon to pin it. On an iPhone, use Safari's **Share →
Add to Home Screen**; on Android, **⋮ → Install app**.

## On a phone

On a phone the app rearranges itself. The board and the notes become two
views, switched with the bar at the bottom, and a floating button adds a task
or a note to whichever is showing. The board shows one column at a time: swipe
sideways for the next. Cards and notes open in a window over the dimmed board;
tap outside it, or the round close button, to close it. Search fills the
screen. The keyboard hints go, and anything that otherwise appears only on
hover (a note entry's delete button, a notes category's buttons) stays
visible. Opening a card doesn't bring up the keyboard; tapping into its text
does.

Dragging (cards, columns, notes, entries) is for the desktop. On a phone a card
moves to another column with the category in its window.

The phone layout follows the screen, not the device's name: it applies to a
touch screen that is narrow, or short (a phone on its side). A tablet keeps the
desktop layout, with the hover-only buttons shown. A computer with a mouse never
changes, however narrow its window.

## Hosting it (Vercel)

The app is a static site, so any static host works. It's quick once open:
everything after the page loads runs in the browser, talking straight to
Supabase. The host only hands out the files.

`vercel.json` has Vercel run `deploy/build.js`, which copies the app's own
files, by name and nothing else, into `dist/`, and writes the site's
`config.local.js` from the Vercel project's environment variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | the publishable key, `sb_publishable_…` |
| `SUPABASE_SCHEMA` | optional, `todo` by default |

These two are public by design: every visitor's browser receives them, and
row-level security is what keeps the data private. The build refuses a secret
or `service_role` key. Your own `config.local.js` is never deployed:
`.vercelignore` keeps it from being uploaded at all, and the build wouldn't copy
it anyway.

The site also asks search engines not to index it, and refuses to be shown
inside another site's frame.

To set it up:

1. **Supabase → Authentication**: check that *Allow new users to sign up* is
   off. Once the site is up, the project URL and key are visible to anyone who
   opens it.
2. **Vercel → Add New → Project**: import this repository. Leave the framework
   as *Other*, since `vercel.json` sets up the build. Add the environment
   variables above, then deploy.
3. **Project → Settings → Domains**: add your domain. If its DNS is hosted
   elsewhere, add the CNAME record Vercel shows at your DNS provider. The HTTPS
   certificate follows by itself.
4. Set up Google sign-in, as below.

After that, every push to the production branch (`main`) goes live.

### Signing in with Google

Google is the only way in. The sign-in screen's **Continue with Google** uses
Supabase's Google provider: the browser goes to Google, then to Supabase, and
comes back signed in. The return is a one-time code only that browser can
redeem (PKCE), never tokens in the address bar. A Google account whose email
matches an existing user signs in as that user; with new sign-ups off, any
other Google account is turned away with a message saying so.

To set it up:

1. **Google Cloud Console**: create a project, set up the consent screen (only
   name, email and profile are asked for, so Google doesn't review it; keep it
   in *Testing* with yourself as the test user, or publish it), and create an
   OAuth client of type *Web application* whose authorized redirect URI is the
   callback URL Supabase shows for its Google provider.
2. **Supabase → Authentication → Sign In / Providers → Google**: turn it on
   and paste in the client ID and secret. The secret stays in Supabase.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add the
   site's address followed by `/**`. The Site URL can stay as it is.

The app has no password sign-in, so Supabase's **Email** provider can be
switched off too, unless other apps on the same Supabase project use it.

## Setting up a fresh project

1. Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor.
   It creates a `todo` schema, six tables, row-level security, and a private
   `todo-images` bucket. It is safe to re-run, and re-running it is also how an
   existing project picks up tables added later, such as the notes tables.
   Until those exist the board works as usual and the notes pane says what to
   run.
2. Add `todo` under **Settings → API → Exposed schemas**. PostgREST only serves
   schemas listed there, and without it every request comes back `404`.
3. Create your user under **Authentication → Users**, with the email address of
   the Google account you'll sign in with, and turn **off** *Allow new users to
   sign up*. Then set up Google sign-in (*Signing in with Google*, above).

Everything lives in a dedicated `todo` schema so one Supabase instance can host
several small projects side by side. Storage buckets are global to the instance,
hence the `todo-` prefix on the bucket and on its policies.

`migrate.html` is the one-shot importer that moved the original `todos.json`
into Supabase. It is kept because it documents the field mapping and would be
the way back in from an export, but it is not needed in normal use.

## Layout

Each **folder** is an independent board — switch between them from the dropdown
in the top left, and add a column with the **+** beside it. Within a folder,
**categories** are the columns, and tasks live inside them. Completed tasks
collapse into a section at the bottom of their column.

To the left of the board is the **notes** pane, which belongs to the folder too:
switching folders switches the notes. Drag its right edge to make it wider or
narrower (double-click the edge to reset), or fold it away with `«`. Both are
remembered on this machine.

A bar along the bottom lists every keyboard shortcut.

## What it does

**Tasks**

- Click a card to open it, or press `Enter` when it has focus. `Space` marks it
  done instead
- Markdown descriptions with a **Write** / **Preview** toggle — bold, italic,
  bulleted and numbered lists, links, and images. Bare URLs are auto-linked
- Star a task to mark it important
- Each card shows its age in days under the checkbox — `3d`, `140d`, `365d`.
  Hover for the exact creation date
- Drag tasks between columns, or to reorder within one
- Moving a card to another column, completing one, or deleting one shows a
  toast saying what happened (`Moved "…" from Inbox to Done`) with **Undo**,
  which puts the card back exactly where it was. `Ctrl+Z` does the same for
  the latest one, even after the toast has gone, as long as you're not typing
  in a field. It's one step, and it won't undo anything changed since (on this
  device or another)
- Drag a column by its grip to reorder the board
- Double-click a column name to rename it

**Keyboard navigation**

Cards are focusable and the arrow keys move between them: up/down within a
column, left/right to the top of the adjacent column. Completed tasks and empty
columns are skipped. Holding `Ctrl` moves the card itself rather than the focus.

`←` from the first column moves into the notes pane, where up/down walk the
category headers and notes, `Enter` opens a note or folds a category, and `→`
goes back to the board.

New cards take focus as soon as they're created, so `Enter` opens straight into
the description with the cursor already in it.

**Due dates**

A task can carry an optional due date, set from the task modal or from quick-add.
Within three days of it — overdue included — an incomplete task pins to the top
of its column, sorted soonest-first, and renders in red with an alert icon.
Dated tasks further out show a muted date. Undated tasks look exactly as they
would without the feature.

Pinned cards can't be reordered by hand, since due-date order overrides manual
placement, but they can still be moved between columns.

**Images**

Paste an image into a description, or use the toolbar button. It uploads to the
private `todo-images` bucket under your user id, and the markdown records it as
`![alt](sb:<uuid>.png)`. Display goes through a one-hour signed URL cached in
memory, so opening the same card repeatedly costs one round trip rather than one
per view.

**Private cards and columns**

A single card can be marked private from the eye button in its detail modal,
next to the star. It renders blurred on the board with a small eye-off marker
beside it, and opening the card shows the real text straight away — there is no
reveal toggle, because opening it is already the deliberate act.

A column can be marked private in its settings (the gear in the column header).
Its card text renders blurred and unselectable, and an eye in the header reveals
it. Revealing lasts only for that session — a private column always comes back
blurred when the app is opened, and turning privacy off and on again never
restores an old reveal.

Search respects both: a match on a private card, or inside a hidden private
column, is blurred in the results and badged **Private**, so the dialog can't be
used to read around the blur. Press `Enter` to open it and read it properly.

This is a screen-privacy measure, not a security one. The rows are ordinary text
in the database and in the JSON export, and opening a card shows it in full. It
stops someone reading your board over your shoulder; it does not protect anything
from someone with access to the data.

**Notes**

The pane on the left is a OneNote-style notebook for the current folder. Notes
sit in categories you create with **+ New category**; each note takes a single
line in the list, showing its heading, how many entries it has when there's more
than one, and when the latest entry was written. Click a category to fold it.

**New note** at the top of the pane (or `Shift+N`) opens a new note in a large
window, at the top of the **Notes** category. Every folder has one, created
automatically; it can be dragged to any position in the list, but it can't be
renamed, deleted or made private, and no other category can take its name. The
`+` on another category's header puts a new note there instead. Every note needs a heading: closing a note that has text but
no heading is refused until you give it one, and a new note closed with nothing
written in it is simply discarded.

Inside, a note is a thread of **entries**, each stamped with the date and time
it was written, newest on top. That suits things like weekly 1:1s, where every
meeting adds an entry to the same note; most notes will only ever have one.
**New entry** (or `Ctrl+Enter`) adds one at the top.

Entries are rich text and always editable: click anywhere in one and type, with
no edit mode to switch into. The toolbar does bold, italic, bulleted and
numbered lists, links and images; `Ctrl+B`, `Ctrl+I` and `Ctrl+K` (link) work
too, typing `- ` or `1. ` at the start of a line starts a list, and `Tab`
indents a list item. Bare URLs become links when you leave the entry, and a
link opens with a single click. Paste an image, or drop one on an entry, and it
appears at once and uploads to the same private bucket as card images.

Pasting from a web page or Word keeps the basic formatting (bold, italic,
lists, links, headings as bold lines) and drops everything else. What an entry
may contain is a short whitelist, rebuilt from scratch on every paste and every
load, so styles, scripts and event handlers from a pasted page can't come along.

Reordering is by drag and drop throughout: entries by the handle to their left
(their timestamps stay as they were), notes within and between categories (drop
on a category's header to put a note at its top), and categories by their
header. The category dropdown in the note window moves a note too.

**Task lists** turn lines in a note into cards. Start one with the task-list
button in the toolbar or by typing `[] ` at the start of a line, or select lines
you've already written (or a bulleted or numbered list) and press the button to
convert them all at once. Each line becomes a card at the top of the folder's
first column, in the list's order, when you finish it: on `Enter`, or when you
leave the entry. A line still being typed has a dashed box and no card yet.

The card holds the text, the done state and the due date; the line in the note
only points at it and shows it, so the two can't disagree. Tick a line and the
card is done; complete the card on the board and the line is ticked. Edit the
text in either place and both change. A due date shows beside the line, red
with the alert icon when it's within three days. Lines are plain text, like a
card's title.

Hover a line for a small arrow, or press `Alt+Enter` in it, to open its card on
top of the note, which is where you set a due date, a description or a star.
The card shows **From note** and a link to that note at the top of its window,
and a small note icon on the board; clicking the link opens the note at that
line.

Removing a line from the note deletes its card when you leave the entry, with
Undo, which brings back the card and the line. While you're still typing,
`Ctrl+Z` gets the line back without the board ever noticing, and cutting a line
and pasting it elsewhere keeps its card. A pasted *copy* of a line becomes plain
text, so one card never has two lines. If the card is deleted on the board, or
cleared as an old completed task, its line stays in the note as plain text: the
note is still a record of what was said. Deleting or archiving a whole note, or
one of its entries, leaves the cards on the board. A private note, or a note in
a private category, makes private cards.

**Diagrams and mind maps** can be entries too. The arrow beside **New entry**
offers Text, Diagram and Mind map. A drawing shows in the thread as a picture
of itself; click it (or press Enter on it) to open it over the whole note
window, and **Done** or `Esc` goes back. Esc steps out one thing at a time:
first the text being typed, then the selection, then the drawing, and only
then the note. A new mind map opens with the cursor already in its centre.
Drawings save like everything else, search finds the words in them, and an
empty diagram or a mind map with no words is dropped when the note closes. A
drawing can be copied out as an image or as SVG, for Confluence and the like.
The editor is described under *Diagrams and mind maps* below.

**Archive** in the note window takes a note out of the list without deleting
it. Archived notes collect in an **Archived** section at the bottom of the pane,
still openable and still searchable; **Unarchive** puts one back where it was.
Deleting a note or an entry offers undo.

Notes can be private in the same two ways as cards: a single note, from the eye
in its window, or a whole category, from its settings (the gear on its header).
Private titles are blurred in the pane, a category's eye reveals it for the
session, and opening a note always shows it in full.

**Search**

`Ctrl+F` opens a search dialog in the middle of the screen. It covers cards
(subjects and descriptions) and notes (headings and entries) in the **current
folder**, including **completed** tasks and **archived** notes, which a board
filter could never have surfaced. Matching notes are listed in their own group
under the cards. Tick
**All folders** in the footer to widen it; that resets to the current folder each
time the dialog opens.

Arrow keys move through the results, `Enter` opens the highlighted card or note
on top of the dialog with the search still underneath, and `Esc` closes it first
and the search second. Each result shows its column — and its folder too when
searching all folders — a snippet of the
notes when the match was there rather than in the subject, and a badge if the
task is done or due. Opening a result in another folder switches the board to it.

**Housekeeping**

The folder dropdown has **Clear completed > 90 days**, which permanently removes
completed tasks in **the current folder** finished more than 90 days ago. Other
folders are untouched. It asks first, naming the folder and the count.

There is no undo — the rows are deleted from the database — so export first if
you want a copy. Images used by those tasks stay in storage; nothing collects
them.

It also has **Export everything as JSON**, which downloads every folder, category
and task in the same shape the original `todos.json` used — readable by eye, and
importable through `migrate.html` if you ever need to rebuild a project. It
also carries every note category, note and entry, archived ones included.
Images are not included: they live in Storage, and the export only carries a
reference to them.

Worth doing occasionally. The free Supabase tier takes no automatic backups, so
this export is the only copy of your data that isn't in the database.

## Checklists

A card can be a checklist: a shopping list, a packing list. In **New task**,
switch on *checklist* before adding it, and the card opens ready for its items;
any existing card gets one from the checklist button at the end of its
toolbar. Type an item and press Enter for the next. Enter in an item moves to
the next one, and Backspace in an empty item removes it.

The card is done exactly when every item is: checking the last item completes
it, and unchecking one, or adding a new one, reopens it. Ticking the card itself
on the board checks every item, and unticking it unchecks them all, which
starts a shopping list over for next time. On the board the card shows how far
along it is (`3/5`), search finds it by its items, and the export includes
them.

Each item is a row of its own, so ticking items on two devices at once merges
item by item. Until `supabase/schema.sql` has been run again to add the
`checklist_items` table, cards are plain and the checklist controls don't show.

## Links to cards, notes and entries

Every card, note and note entry has its own link. The link icon at the top of
a card's or a note's window, or in an entry's header (on the desktop it shows
when the pointer is over the entry), copies it. The link is the app's address
with the item after a `#` (`#card=…`, `#note=…`, `#entry=…`), so it can be
pasted anywhere: a chat, an email, another app.

Opening one lands on that item: the app switches to its folder and opens the
card or note, or opens the note and scrolls to the entry. Signed out, it asks
you to sign in first and then opens the item. The `#` part is taken off the
address once read, so a reload doesn't open it again. A link to something since
deleted says so.

Pasted into a note, or into a card's description, such a link shows as the
item itself: a link icon and the card's or note's title as it is now (an entry
shows its note's title and date), struck through for a card that's done,
*Private* for a private one, and *Deleted* once it's gone. Clicking it opens
the item right here instead of in a new tab. A bare address becomes one when
you leave the entry, and in a card it shows in Preview. Only the look changes:
what's saved is still the plain link.

Where a link opens is up to the device. On a computer with the app installed
from Chrome, links open in the app's own window if its *Open supported links*
setting is on (the manifest's `launch_handler` hands the link to the window
that's already open); otherwise in a browser tab. On an iPhone they open in
Safari, since iOS doesn't send links to home-screen apps.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `N` | New task (when not typing in a field) |
| `Shift+N` | New note |
| `↑` `↓` | Move focus within a column |
| `←` `→` | Move focus to the top of the adjacent column; `←` from the first column moves into the notes pane |
| `Ctrl` + arrows | Move the focused card itself |
| `Enter` | Open the focused card or note; on a notes category, fold or unfold it |
| `Space` | Mark the focused card done |
| `Esc` | Close the topmost dialog (saving edits), then the search |
| `Ctrl+Z` | Undo the latest move, completion or delete (outside text fields) |
| `Ctrl+F` | Search |
| `Space` | In a task's Preview pane, switch to Write |
| `Ctrl+B` / `Ctrl+I` | Bold / italic, inside a task description |
| `Ctrl+Enter` | Submit from the quick-add description field; in a note, add an entry |
| `Ctrl+K` | In a note, link the selected text |
| `[]` + `Space` | In a note, start a task list |
| `Alt+Enter` | On a task-list line, open its card |
| `Tab` / `Shift+Tab` | In a note's list, indent / outdent |

On a Mac use `⌘` — every shortcut accepts either modifier. Note that macOS
intercepts `Ctrl`+arrows for Mission Control, so use `⌘`+arrows to move cards
there. The on-screen legend always says `Ctrl`.

## How saving works

This is the part that keeps the app instant despite a database behind it.

Every edit changes an in-memory object and re-renders synchronously — the same
code path as when a local file backed it, measured at well under a millisecond.
Nothing on the render path ever awaits the network.

Writes happen on a timer. Roughly 800ms after you stop making changes, the app
diffs a snapshot of the whole state against what it last successfully wrote, and
sends only the rows that actually differ. Ids are generated by the client, so
each is a plain upsert. Deletes go before inserts so foreign keys stay satisfied.

Diffing a snapshot rather than tracking dirty rows at each call site also makes
failure boring: if a write fails the snapshot isn't advanced, the dot turns red,
and the next flush retries the same rows. Nothing is lost and nothing has to be
replayed in order.

Hiding the tab flushes immediately. Closing it with an unsaved change still
inside the debounce window prompts before leaving.

The dot in the top right shows the state — saving, saved, or error.

### Changes from other devices

Open on the desktop and the phone at once, each shows the other's changes
without a reload. The app listens for changes to its tables (Supabase
Realtime; `supabase/schema.sql` adds them to the `supabase_realtime`
publication), and also catches up whenever it comes back on screen after a
few seconds away, since a phone drops the connection in the background. Its
own writes come back over the same connection too; those match what it just
saved and are ignored.

Either way it then reads everything again and merges three ways, row by row,
using the snapshot of what it last saved: a row changed on this device and not
yet saved keeps this device's version (and is saved as usual), and every other
row takes what the database has, including rows added or deleted elsewhere.
So the same card edited on both at once ends with whichever saved last.

The objects in memory are updated in place, so an open card or note keeps
working, and nothing being typed is redrawn under the cursor: an open card's
other fields follow, a note being typed in is redrawn when the typing stops,
and the board keeps its scroll positions and open "Completed" lists.

Requests that Supabase's database turns away because its clock lags the
sign-in service's by a second or two ("JWT issued at future") are sent again
after a moment.

## Your data

Everything lives in your Supabase project, under your user id, behind row-level
security. Every policy keys off `auth.uid()`, which is `NULL` for an
unauthenticated caller and therefore matches no row and permits no insert. That
is why the publishable key being public is not a problem.

Nothing in this repo contains your data or your credentials.

The original `todos.json` and `assets/` are gitignored and no longer read by the
app. Keeping them as a cold backup costs nothing.

## Data model

Seven tables in the `todo` schema. Columns are snake_case in Postgres and
camelCase in the app; the mapping happens in one place on load and one on save.

```
folders     id, user_id, name, position, updated_at
categories  id, user_id, folder_id, name, private, position, updated_at
tasks       id, user_id, folder_id, category_id, subject, description,
            completed, important, private, due_date, position,
            created_at, completed_at, updated_at
checklist_items  id, user_id, task_id, text, done, position, created_at, updated_at

note_categories  id, user_id, folder_id, name, private, position, updated_at
notes            id, user_id, category_id, title, private, archived,
                 archived_at, position, created_at, updated_at
note_entries     id, user_id, note_id, kind, body, position, created_at, updated_at
```

An entry's `kind` is `text`, `diagram` or `mindmap`. A text entry's `body` is
the sanitised HTML described under Notes; a drawing's is its data as JSON, in
the shape documented at the top of `canvas.js`. Before the `kind` column exists
the app still works, it just doesn't offer drawings. A task list is
`<ul data-tasks>` with `<li data-task="<card id>">` lines; the id is the only
link between a line and its card, and everything a line displays (ticked, due
date) is read from the card when the note is drawn. Images in it are
`<img data-sb="<uuid>.png">`, a reference into the bucket and never a URL, since
signed URLs expire. An entry's `created_at` is the timestamp it shows, and
reordering entries changes only `position`.

A note's heading is required by the app but deliberately not by the database: a
note is saved while it's being written, before it has a heading, and a
constraint would turn that into lost text.

Every table is read in pages of 1000 rows, the most PostgREST returns in one
response.

`position` is the manual order within a parent, renumbered from zero on every
write. Due-date pinning is applied at render time and never stored, so clearing
a date restores the manual order exactly.

`due_date` is a plain date with no time or zone, so "due today" means today
wherever you are.

## Diagrams and mind maps

`canvas.js` is the home-grown drawing editor behind diagram and mind-map note
entries. `canvas-prototype.html` is a test bench for it outside the app: it
keeps its drawings in the browser's localStorage and never touches your notes.

**Diagrams** are drawn by hand, in the style of Miro. Rectangles (with only
slightly softened corners) and ovals sit on a snapping grid, in 5 colours, and
can be resized. Each shape has four connection dots: drag one onto another
shape to connect them (a dot can take any number of lines), or into open space
for a new connected shape; the + beside each side adds a connected copy. Lines
are right-angled, straight or curved, arrows at one end, both or neither, and
can carry a label. Text shrinks to fit its shape.

**Mind maps** are a tree around a central topic, with boxes that size
themselves to their text (several lines allowed). The + on a box adds a
branch, placed automatically; dragging out from one of its dots grows one in
another direction. Drag a box to move its whole branch (it turns to face the
other way if it crosses its parent), drop it on another box to re-attach it,
fold away the branches on one side of a box (the − on that edge; each side
folds on its own), or tidy a branch or the whole map. While typing, Tab starts
a branch, Enter the next box on the same level (inserted straight after, with
room made around it), and Shift+Enter a new line inside the box; Enter on a
new box that's still empty removes it and stops. On a selected box, Tab adds a
child and Enter a sibling.

Both are mouse-first: click to select, drag empty space to select several,
and scroll to zoom. To move around, drag with Ctrl held (from anywhere, even
on a shape), with Space held, or with the right mouse button; the canvas shows
this in its corner. Undo and redo are buttons (Delete, Ctrl+Z and Ctrl+Y work
too).

With a finger: drag the background to move around, pinch to zoom, drag a box to
move it, tap a box to show its dots and + buttons, and double-tap it to edit
its text. A second finger landing mid-drag starts a pinch and puts the box
back. The buttons are bigger, and the bar over a selection wraps rather than
run off a narrow screen.

**Copying out.** The last button in the zoom bar copies the whole drawing
(folded-away branches stay out), cropped to what's there:

- **Copy as image** puts a PNG on the clipboard, at twice the size for
  sharpness, on white. It pastes anywhere that takes a picture: Confluence
  pages and whiteboards, Teams, Slack, email, Word, PowerPoint.
- **Copy as SVG** puts the same picture on the clipboard as SVG markup, as
  text and, where the browser offers it, as an SVG image. It's for apps that
  read SVG, such as Figma, or for saving as an `.svg` file: it stays sharp at
  any size and its words stay text.

The copy is its own clean drawing rather than a snapshot of the editor: the
editor shows its text with HTML, which only a browser can display, so the copy
writes real SVG text instead, with each box's lines broken exactly where the
page breaks them, and colours and arrowheads written onto every shape and line
so nothing depends on the page's styles. In Confluence it lands as a picture,
not as whiteboard shapes and connectors: Confluence only builds those from its
own tools or from a Miro, Mural or FigJam import.

It's a plain script rather than a module, for the same file:// reason as the
bundled library below, and it knows nothing about Supabase: it's handed a
drawing as plain data and reports every finished change, and whatever embeds
it does the saving.

## A note on the bundled library

`index.html` contains supabase-js v2.116.0 inlined verbatim as a UMD bundle,
which accounts for most of its size. It's inlined rather than imported because an
ES module import is CORS-checked and would be refused on `file://`, and a CDN
fetch would make startup depend on a third party. To upgrade, replace that one
`<script>` block with a newer UMD build.

`TODO_APP_SPEC.md` holds the original build spec, from when this was a local-file
app. It's kept for history and no longer describes the implementation.
