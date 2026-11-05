-- HeimDesk: checks that no one can reach another user's data. Paste the whole
-- file into the Supabase SQL Editor and run it, after supabase/schema.sql.
--
-- It checks how the schema is set up, then makes two throwaway users, A and
-- B, gives A some data, and acts as B (the way the app's requests do) trying
-- everything B shouldn't be able to: read A's rows, change or delete them,
-- take them over, hang rows off them, reach A's images, or join or send on
-- A's live-update channel. Then it checks that someone signed out gets
-- nothing at all.
--
-- The live-update checks need Realtime to have set up today's message table,
-- which it does when a device connects: have HeimDesk open somewhere.
--
-- It ALWAYS ends with an error, on purpose: the error is what undoes every
-- user and row it made, so nothing is left behind whatever happens. Read the
-- message:
--   RLS TEST PASSED: ...   every check held
--   RLS TEST FAILED: ...   which check didn't (and still, nothing was changed)

do $$
declare
  tables constant text[] := array['folders', 'categories', 'tasks', 'checklist_items',
                                  'note_categories', 'notes', 'note_entries'];
  a uuid := gen_random_uuid();   -- the victim
  b uuid := gen_random_uuid();   -- the one trying
  fa uuid := gen_random_uuid(); ca uuid := gen_random_uuid(); ta uuid := gen_random_uuid();
  ia uuid := gen_random_uuid(); nca uuid := gen_random_uuid(); na uuid := gen_random_uuid();
  ea uuid := gen_random_uuid(); fb uuid := gen_random_uuid(); cb uuid := gen_random_uuid();
  ncb uuid := gen_random_uuid(); ia2 uuid := gen_random_uuid();
  t text;
  n bigint;
  ok boolean;
  why text;
  ra boolean[]; wa boolean[];
  checks int := 0;
  notes text := '';
  storage_tested boolean := false;
  -- What the app computes for this text in the browser (SHA-256 of its
  -- UTF-8), worked out beforehand; the announcement must match it exactly.
  blue constant text := U&'Bl\00E5b\00E6r \2013 \+01F642';
  blue_sha256 constant text := 'a08a3d4dad186f66cdf9137c0fae11e907f0b2e9bdacd577c2d814a4944ff69c';
begin
  -- ===== How the schema is set up =====
  if to_regprocedure('heimdesk.broadcast_change()') is null then
    raise exception 'RLS TEST FAILED: heimdesk.broadcast_change() doesn''t exist. Run supabase/schema.sql first.';
  end if;
  foreach t in array tables loop
    if to_regclass('heimdesk.' || t) is null then
      raise exception 'RLS TEST FAILED: heimdesk.% doesn''t exist. Run supabase/schema.sql first.', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('heimdesk.' || t)::regclass) then
      raise exception 'RLS TEST FAILED: row-level security is off on heimdesk.%', t;
    end if;
    if has_table_privilege('anon', 'heimdesk.' || t, 'select, insert, update, delete, truncate, references, trigger') then
      raise exception 'RLS TEST FAILED: the signed-out role (anon) has privileges on heimdesk.%', t;
    end if;
    if has_table_privilege('authenticated', 'heimdesk.' || t, 'truncate, references, trigger') then
      raise exception 'RLS TEST FAILED: signed-in users can truncate, reference or add triggers to heimdesk.%', t;
    end if;
    if not has_table_privilege('authenticated', 'heimdesk.' || t, 'select')
       or not has_table_privilege('authenticated', 'heimdesk.' || t, 'insert')
       or not has_table_privilege('authenticated', 'heimdesk.' || t, 'update')
       or not has_table_privilege('authenticated', 'heimdesk.' || t, 'delete') then
      raise exception 'RLS TEST FAILED: signed-in users are missing a privilege on heimdesk.% the app needs', t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'heimdesk' and tablename = t) then
      raise exception 'RLS TEST FAILED: heimdesk.% has no policy', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'heimdesk' and tablename = t
               and (roles <> array['authenticated']::name[]
                    or coalesce(qual, '') not like '%auth.uid()%'
                    or (cmd in ('ALL', 'INSERT', 'UPDATE') and coalesce(with_check, '') not like '%auth.uid()%'))) then
      raise exception 'RLS TEST FAILED: heimdesk.% has a policy that isn''t "signed-in owner only"', t;
    end if;
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'heimdesk' and tablename = t) then
      raise exception 'RLS TEST FAILED: heimdesk.% is in the realtime publication, which tells everyone listening the ids of other users'' deleted rows', t;
    end if;
    -- After (not before) insert, update and delete, once per row (tgtype bits
    -- 1 row, 2 before, 4 insert, 8 delete, 16 update), and switched on.
    if not exists (select 1 from pg_trigger
                   where tgrelid = ('heimdesk.' || t)::regclass and not tgisinternal and tgenabled <> 'D'
                     and tgfoid = 'heimdesk.broadcast_change()'::regprocedure
                     and tgtype & 31 = 29) then
      raise exception 'RLS TEST FAILED: heimdesk.% has no live-update trigger, so other devices would miss its changes', t;
    end if;
    checks := checks + 8;
  end loop;

  -- Every link between tables goes through the owner too.
  if exists (select 1 from pg_constraint c
             where c.contype = 'f'
               and c.connamespace = 'heimdesk'::regnamespace
               and c.confrelid in (select oid from pg_class where relnamespace = 'heimdesk'::regnamespace)
               and not exists (select 1 from pg_attribute
                               where attrelid = c.conrelid and attname = 'user_id'
                                 and attnum = any (c.conkey))) then
    raise exception 'RLS TEST FAILED: a foreign key between heimdesk tables doesn''t include user_id';
  end if;
  checks := checks + 1;

  if exists (select 1 from pg_proc where pronamespace = 'heimdesk'::regnamespace and prosecdef) then
    raise exception 'RLS TEST FAILED: a function in heimdesk is security definer';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'heimdesk'::regnamespace
             and (has_function_privilege('anon', oid, 'execute')
                  or has_function_privilege('authenticated', oid, 'execute'))) then
    raise exception 'RLS TEST FAILED: a function in heimdesk can be called through the API';
  end if;
  checks := checks + 2;

  -- Live updates. Realtime lets someone join a private channel only if
  -- row-level security on realtime.messages lets them read a test message on
  -- it, and send on it only if they could insert one.
  if not (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass) then
    raise exception 'RLS TEST FAILED: row-level security is off on realtime.messages, so anyone could join anyone''s live channel';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                 and policyname = 'heimdesk_live_receive' and cmd = 'SELECT'
                 and roles = array['authenticated']::name[]
                 and qual like '%heimdesk:%' and qual like '%auth.uid()%')
     or not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                    and policyname = 'heimdesk_live_send' and cmd = 'INSERT'
                    and roles = array['authenticated']::name[]
                    and with_check like '%heimdesk:%' and with_check like '%auth.uid()%'
                    and with_check like '%heimdesk.broadcast%')
     or exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                and policyname like 'heimdesk\_%'
                and policyname not in ('heimdesk_live_receive', 'heimdesk_live_send')) then
    raise exception 'RLS TEST FAILED: the live-update policies on realtime.messages aren''t the two "signed-in owner''s own channel" ones';
  end if;
  checks := checks + 2;

  if not exists (select 1 from storage.buckets where id = 'todo-images') then
    raise exception 'RLS TEST FAILED: the todo-images bucket doesn''t exist';
  end if;
  if exists (select 1 from storage.buckets where id = 'todo-images'
             and (public or file_size_limit is null or file_size_limit > 10485760
                  or allowed_mime_types is null
                  or exists (select 1 from unnest(allowed_mime_types) m
                             where m not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')))) then
    raise exception 'RLS TEST FAILED: the todo-images bucket is public, or has no size limit, or allows types beyond PNG, JPEG, GIF and WebP';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname like 'todo\_images\_%'
        and roles = array['authenticated']::name[]
        and coalesce(qual, with_check) like '%todo-images%'
        and coalesce(qual, with_check) like '%auth.uid()%') <> 4
     or exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                and policyname like 'todo\_images\_%' and cmd = 'UPDATE'
                and coalesce(with_check, '') not like '%auth.uid()%') then
    raise exception 'RLS TEST FAILED: the todo-images policies aren''t the four "signed-in owner''s own folder" ones';
  end if;
  checks := checks + 3;

  -- ===== Two throwaway users =====
  begin
    insert into auth.users (id, aud, role, email)
    values (a, 'authenticated', 'authenticated', 'rls-test-a-' || a || '@example.invalid'),
           (b, 'authenticated', 'authenticated', 'rls-test-b-' || b || '@example.invalid');
  exception when others then
    raise exception 'RLS TEST FAILED: couldn''t make the throwaway users (%). Nothing was changed.', sqlerrm;
  end;

  -- ===== A, signed in, makes one of everything =====
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  insert into heimdesk.folders (id, name) values (fa, 'A folder');
  insert into heimdesk.categories (id, folder_id, name) values (ca, fa, 'A column');
  insert into heimdesk.tasks (id, folder_id, category_id, subject) values (ta, fa, ca, 'A card');
  insert into heimdesk.checklist_items (id, task_id, text) values (ia, ta, 'A item');
  insert into heimdesk.note_categories (id, folder_id, name) values (nca, fa, 'A notes');
  insert into heimdesk.notes (id, category_id, title) values (na, nca, 'A note');
  insert into heimdesk.note_entries (id, note_id, body) values (ea, na, 'A entry');
  foreach t in array tables loop
    execute format('select count(*) from heimdesk.%I', t) into n;
    if n <> 1 then raise exception 'RLS TEST FAILED: A sees % rows of their own in %, not 1', n, t; end if;
  end loop;
  checks := checks + 1;

  -- ===== A's live channel =====
  -- A changes a card and adds and deletes a checklist item: with the seven
  -- rows above, ten changes, each announced on A's own channel.
  update heimdesk.tasks set description = blue where id = ta;
  insert into heimdesk.checklist_items (id, task_id, text) values (ia2, ta, 'A gone');
  delete from heimdesk.checklist_items where id = ia2;
  select count(*) into n from realtime.messages
   where topic = 'heimdesk:' || a and extension = 'broadcast' and private;
  if n <> 10 then
    -- realtime.send turns failures into a warning. Send one the way the
    -- trigger does, to show why.
    begin
      perform set_config('heimdesk.broadcast', 'on', true);
      insert into realtime.messages (topic, extension, private, event, payload)
      values ('heimdesk:' || a, 'broadcast', true, 'TEST', '{}');
      perform set_config('heimdesk.broadcast', '', true);
      why := 'a test message sent the same way went through';
    exception when others then
      why := sqlerrm;
    end;
    raise exception 'RLS TEST FAILED: % of A''s 10 changes were announced on their live channel (%). If that says no partition was found, open HeimDesk on any device, so that Realtime sets up today''s messages, and run this again.', n, why;
  end if;
  if exists (select 1 from realtime.messages m,
                    unnest(array['A folder', 'A column', 'A card', 'A item', 'A notes', 'A note',
                                 'A entry', 'A gone', U&'Bl\00E5b\00E6r']) as s(txt)
             where m.topic = 'heimdesk:' || a and position(s.txt in m.payload::text) > 0) then
    raise exception 'RLS TEST FAILED: an announcement on A''s live channel carries A''s text, which realtime.messages keeps for days';
  end if;
  if (select count(*) from realtime.messages
       where topic = 'heimdesk:' || a and event = 'UPDATE'
         and payload ->> 'table' = 'tasks' and payload ->> 'type' = 'UPDATE'
         and payload ->> 'row_id' = ta::text
         and payload -> 'row' ->> 'category_id' = ca::text
         and payload -> 'row' ->> 'user_id' = a::text
         and not (payload -> 'row' ? 'subject') and not (payload -> 'row' ? 'description')
         and payload -> 'sha256' ->> 'subject' = encode(sha256(convert_to('A card', 'UTF8')), 'hex')
         and payload -> 'sha256' ->> 'description' = blue_sha256) <> 1 then
    raise exception 'RLS TEST FAILED: the announcement of A''s changed card isn''t what the app expects: its id, its other columns, and its text as the SHA-256 the browser computes';
  end if;
  if (select count(*) from realtime.messages
       where topic = 'heimdesk:' || a and event = 'DELETE'
         and payload ->> 'table' = 'checklist_items' and payload ->> 'type' = 'DELETE'
         and payload ->> 'row_id' = ia2::text
         and not (payload ? 'row') and not (payload ? 'sha256')) <> 1 then
    raise exception 'RLS TEST FAILED: the announcement of A''s deleted checklist item isn''t just its id';
  end if;
  checks := checks + 4;

  begin
    insert into storage.objects (bucket_id, name, owner, owner_id)
    values ('todo-images', a || '/rls-test.png', a, a::text);
    storage_tested := true;
  exception when others then
    notes := notes || format(' (The image checks were skipped: storage wouldn''t take a test file directly, %s.)', sqlerrm);
  end;

  -- ===== B, signed in, tries everything =====
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);

  insert into heimdesk.folders (id, name) values (fb, 'B folder');
  insert into heimdesk.categories (id, folder_id, name) values (cb, fb, 'B column');
  insert into heimdesk.note_categories (id, folder_id, name) values (ncb, fb, 'B notes');

  -- Read A's rows.
  foreach t in array tables loop
    execute format('select count(*) from heimdesk.%I where user_id = %L', t, a) into n;
    if n <> 0 then raise exception 'RLS TEST FAILED: B can read A''s rows in %', t; end if;
  end loop;
  checks := checks + 1;

  -- Change or delete A's rows.
  foreach t in array tables loop
    execute format('update heimdesk.%I set updated_at = now() where user_id = %L', t, a);
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'RLS TEST FAILED: B can change A''s rows in %', t; end if;
    execute format('delete from heimdesk.%I where user_id = %L', t, a);
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'RLS TEST FAILED: B can delete A''s rows in %', t; end if;
  end loop;
  checks := checks + 2;

  -- Each attempt below counts as refused only when the policies refuse it
  -- (insufficient_privilege) or the links to the owner do
  -- (foreign_key_violation). Any other error stops the test with that error,
  -- so a check can't pass by failing for some unrelated reason.

  -- Make a row that belongs to A.
  ok := false;
  begin
    insert into heimdesk.folders (id, user_id, name) values (gen_random_uuid(), a, 'planted');
  exception when insufficient_privilege or foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: B can make a row that belongs to A'; end if;

  -- Give B's own row to A.
  ok := false;
  begin
    update heimdesk.folders set user_id = a where id = fb;
  exception when insufficient_privilege or foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: B can give a row to A'; end if;

  -- Take over A's row by saving one with the same id (the app saves by upsert).
  ok := false;
  begin
    insert into heimdesk.tasks (id, folder_id, category_id, subject) values (ta, fb, cb, 'taken')
      on conflict (id) do update set subject = excluded.subject, folder_id = excluded.folder_id,
                                     category_id = excluded.category_id;
  exception when insufficient_privilege or foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: B can take over A''s card by saving one with its id'; end if;
  checks := checks + 3;

  -- Hang B's rows off A's (knowing their ids).
  ok := false;
  begin insert into heimdesk.categories (id, folder_id, name) values (gen_random_uuid(), fa, 'x');
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a column to A''s folder'; end if;
  ok := false;
  begin insert into heimdesk.tasks (id, folder_id, category_id) values (gen_random_uuid(), fb, ca);
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a card to A''s column'; end if;
  ok := false;
  begin insert into heimdesk.tasks (id, folder_id, category_id) values (gen_random_uuid(), fa, cb);
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a card to A''s folder'; end if;
  ok := false;
  begin insert into heimdesk.checklist_items (id, task_id) values (gen_random_uuid(), ta);
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a checklist item to A''s card'; end if;
  ok := false;
  begin insert into heimdesk.note_categories (id, folder_id, name) values (gen_random_uuid(), fa, 'x');
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a notes category to A''s folder'; end if;
  ok := false;
  begin insert into heimdesk.notes (id, category_id) values (gen_random_uuid(), nca);
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add a note to A''s notes category'; end if;
  ok := false;
  begin insert into heimdesk.note_entries (id, note_id) values (gen_random_uuid(), na);
  exception when insufficient_privilege or foreign_key_violation then ok := true; end;
  if not ok then raise exception 'RLS TEST FAILED: B can add an entry to A''s note'; end if;
  checks := checks + 7;

  -- Join A's live channel: Realtime has B read a test message on it, as B,
  -- with realtime.topic set to it. A's own announcements will do.
  perform set_config('realtime.topic', 'heimdesk:' || a, true);
  select count(*) into n from realtime.messages where topic = 'heimdesk:' || a;
  if n <> 0 then raise exception 'RLS TEST FAILED: B can join A''s live channel and hear A''s changes'; end if;

  -- Send on A's channel, even the way the trigger does.
  ok := false;
  begin
    perform set_config('heimdesk.broadcast', 'on', true);
    insert into realtime.messages (topic, extension, private, event, payload)
    values ('heimdesk:' || a, 'broadcast', true, 'DELETE',
            jsonb_build_object('table', 'tasks', 'type', 'DELETE', 'row_id', ta));
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: B can send on A''s live channel'; end if;

  -- Send on their own channel with no change behind it, as any app could try.
  ok := false;
  begin
    insert into realtime.messages (topic, extension, private, event, payload)
    values ('heimdesk:' || b, 'broadcast', true, 'DELETE', '{}');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: B can send on their own live channel without a change behind it'; end if;
  checks := checks + 3;

  -- A's images.
  if storage_tested then
    select count(*) into n from storage.objects where bucket_id = 'todo-images' and name like a || '/%';
    if n <> 0 then raise exception 'RLS TEST FAILED: B can see A''s images'; end if;
    ok := false;
    begin
      insert into storage.objects (bucket_id, name, owner, owner_id)
      values ('todo-images', a || '/planted.png', b, b::text);
    exception when insufficient_privilege or foreign_key_violation then ok := true;
    end;
    if not ok then raise exception 'RLS TEST FAILED: B can put an image in A''s folder'; end if;
    checks := checks + 2;

    -- Deleting A's images. Supabase blocks deletes from its storage tables in
    -- SQL, for everyone, so that files and rows stay in step. The test lifts
    -- that block for this transaction only; the policies still apply. Then A
    -- deletes their own test image, to show that a delete really goes through
    -- here, so that B deleting nothing means something. Where the block can't
    -- be lifted, deleting is covered by the policy check at the top, and the
    -- result says so.
    perform set_config('storage.allow_delete_query', 'true', true);
    ok := false;
    begin
      delete from storage.objects where bucket_id = 'todo-images' and name like a || '/%';
      get diagnostics n = row_count;
      ok := true;
    exception when insufficient_privilege then
      notes := notes || format(' (Deleting images is covered by the policy check only: %s)', sqlerrm);
    end;
    if ok then
      if n <> 0 then raise exception 'RLS TEST FAILED: B can delete A''s images'; end if;
      perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
      begin
        delete from storage.objects where bucket_id = 'todo-images' and name = a || '/rls-test.png';
        get diagnostics n = row_count;
      exception when insufficient_privilege then n := 0;
      end;
      if n = 1 then
        checks := checks + 1;
      else
        notes := notes || ' (Deleting images is covered by the policy check only: a test delete didn''t go through here.)';
      end if;
    end if;
  end if;

  -- ===== Realtime's own join check =====
  -- As Realtime's server runs it, where the SQL editor may call it: B on A's
  -- channel, then A on their own.
  execute 'reset role';
  ra := null;
  begin
    select read_allowed, write_allowed into ra, wa from realtime.authorize(
      'authenticated', 'heimdesk:' || a, json_build_object('sub', b, 'role', 'authenticated')::text,
      b::text, '{}', array['broadcast'], array['broadcast']);
  exception when others then
    why := sqlerrm;
  end;
  if ra is not null then
    if ra[1] or wa[1] then
      raise exception 'RLS TEST FAILED: Realtime''s own check lets B join or send on A''s live channel';
    end if;
    select read_allowed, write_allowed into ra, wa from realtime.authorize(
      'authenticated', 'heimdesk:' || a, json_build_object('sub', a, 'role', 'authenticated')::text,
      a::text, '{}', array['broadcast'], array['broadcast']);
    if not ra[1] or wa[1] then
      raise exception 'RLS TEST FAILED: Realtime''s own check doesn''t let A join their own live channel to listen, and only listen';
    end if;
    checks := checks + 1;
  else
    notes := notes || format(' (Realtime''s own join check couldn''t be run from the SQL editor: %s. The checks that act as B cover the same policies.)', why);
  end if;

  -- ===== Signed out =====
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  foreach t in array tables loop
    ok := false;
    begin
      execute format('select count(*) from heimdesk.%I', t) into n;
    exception when insufficient_privilege then ok := true;
    end;
    if not ok then raise exception 'RLS TEST FAILED: someone signed out can query heimdesk.%', t; end if;
  end loop;
  checks := checks + 1;

  -- Hear any HeimDesk live channel.
  perform set_config('realtime.topic', 'heimdesk:' || a, true);
  ok := false;
  begin
    select count(*) into n from realtime.messages where topic like 'heimdesk:%';
    ok := n = 0;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'RLS TEST FAILED: someone signed out can hear live updates'; end if;
  checks := checks + 1;

  -- ===== A's data came through it all =====
  execute 'reset role';
  if (select subject from heimdesk.tasks where id = ta) is distinct from 'A card'
     or (select count(*) from heimdesk.checklist_items where task_id = ta) <> 1
     or (select count(*) from heimdesk.note_entries where note_id = na) <> 1 then
    raise exception 'RLS TEST FAILED: A''s data was changed by B''s attempts';
  end if;
  -- And A's channel still holds just A's ten announcements.
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from realtime.messages where topic = 'heimdesk:' || a;
  execute 'reset role';
  if n <> 10 then
    raise exception 'RLS TEST FAILED: something besides A''s own changes was announced on A''s live channel';
  end if;
  checks := checks + 2;

  raise exception 'RLS TEST PASSED: all % checks held.% Everything the test made has been undone (this error is what undoes it).',
    checks, notes;
end $$;
