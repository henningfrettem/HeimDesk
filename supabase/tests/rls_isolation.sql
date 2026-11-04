-- HeimDesk: checks that no one can reach another user's data. Paste the whole
-- file into the Supabase SQL Editor and run it, after supabase/schema.sql.
--
-- It checks how the schema is set up, then makes two throwaway users, A and
-- B, gives A some data, and acts as B (the way the app's requests do) trying
-- everything B shouldn't be able to: read A's rows, change or delete them,
-- take them over, hang rows off them, or reach A's images. Then it checks
-- that someone signed out gets nothing at all.
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
  ncb uuid := gen_random_uuid();
  t text;
  n bigint;
  ok boolean;
  checks int := 0;
  notes text := '';
  storage_tested boolean := false;
begin
  -- ===== How the schema is set up =====
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
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'heimdesk' and tablename = t) then
      raise exception 'RLS TEST FAILED: heimdesk.% isn''t in the realtime publication, so live sync would miss it', t;
    end if;
    checks := checks + 7;
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

  -- ===== A's data came through it all =====
  execute 'reset role';
  if (select subject from heimdesk.tasks where id = ta) is distinct from 'A card'
     or (select count(*) from heimdesk.checklist_items where task_id = ta) <> 1
     or (select count(*) from heimdesk.note_entries where note_id = na) <> 1 then
    raise exception 'RLS TEST FAILED: A''s data was changed by B''s attempts';
  end if;
  checks := checks + 1;

  raise exception 'RLS TEST PASSED: all % checks held.% Everything the test made has been undone (this error is what undoes it).',
    checks, notes;
end $$;
