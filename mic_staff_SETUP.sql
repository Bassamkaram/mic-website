-- ============================================================================
-- MIC staff tablet — roles, tasks, push notifications, proof photos
--
-- Paste the whole of this into the Supabase SQL editor and press Run, once.
-- Safe to run again at any time.
--
-- The last thing it does is print a short table telling you what is ready.
-- If any line there does not say "ready", send Claude a screenshot of it.
-- ============================================================================


-- ------------------------------------------------------------ staff roles --
-- Who may use the booking console (admin) and who may only look (viewer).
-- Admins are managed here from now on, instead of a list written into code.
create table if not exists public.booking_staff (
  email       text primary key check (email = lower(email)),
  name        text,
  role        text not null check (role in ('admin','viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.booking_staff (email, role) values
  ('bassamkaram@gmail.com',       'admin'),
  ('amanda.a.abdallah@gmail.com', 'admin'),
  ('info@mic-lb.com',             'admin')
on conflict (email) do nothing;

-- Admin: may change anything.
create or replace function public.is_booking_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.booking_staff s
    where s.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and s.role = 'admin' and s.active
  );
$$;

-- Member: admin or viewer. May look, may complete tasks, may not edit bookings.
create or replace function public.is_booking_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.booking_staff s
    where s.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and s.active
  );
$$;

revoke all on function public.is_booking_staff()  from public;
revoke all on function public.is_booking_member() from public;
grant execute on function public.is_booking_staff()  to anon, authenticated;
grant execute on function public.is_booking_member() to anon, authenticated;

alter table public.booking_staff enable row level security;
-- deliberately not FORCE: the functions above read this table as its owner

drop policy if exists booking_staff_admin_all on public.booking_staff;
create policy booking_staff_admin_all on public.booking_staff
  for all to authenticated
  using (public.is_booking_staff()) with check (public.is_booking_staff());

drop policy if exists booking_staff_read_self on public.booking_staff;
create policy booking_staff_read_self on public.booking_staff
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

grant select, insert, update, delete on public.booking_staff to authenticated;

-- The console can never be left without an admin: the last active admin
-- cannot be removed, switched off or turned into a viewer.
create or replace function public.booking_staff_keep_an_admin()
returns trigger language plpgsql as $$
begin
  if old.role = 'admin' and old.active
     and (tg_op = 'DELETE' or new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.booking_staff
                      where role = 'admin' and active and email <> old.email) then
    raise exception 'There must always be at least one active admin.' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists booking_staff_keep_an_admin on public.booking_staff;
create trigger booking_staff_keep_an_admin before update or delete on public.booking_staff
  for each row execute function public.booking_staff_keep_an_admin();


-- ------------------------------------------- bookings: viewers may look --
-- The owner of these tables must be able to read them for the public
-- availability calendar and the functions below to work, so they are not
-- FORCE-d. The public and staff are still bound by every policy.
alter table public.room_bookings  no force row level security;
alter table public.booking_addons no force row level security;

drop policy if exists room_bookings_member_read on public.room_bookings;
create policy room_bookings_member_read on public.room_bookings
  for select to authenticated
  using (public.is_booking_member());
-- Changing a booking still needs the admin-only policy from the first setup.


-- ------------------------------------------------------------------ tasks --
create table if not exists public.staff_tasks (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       text default lower(coalesce(auth.jwt() ->> 'email', '')),

  title            text not null check (length(btrim(title)) between 1 and 160),
  details          text,
  priority         text not null default 'normal' check (priority in ('normal','urgent')),
  due_at           timestamptz,
  assigned_to      text check (assigned_to is null or assigned_to = lower(assigned_to)),  -- null: every viewer
  booking_request  uuid,                                                                     -- optional link

  status           text not null default 'open' check (status in ('open','done')),
  done_at          timestamptz,
  done_by          text,
  done_note        text,
  proof_path       text,
  proof_type       text check (proof_type is null or proof_type in ('image','video'))
);
create index if not exists staff_tasks_board on public.staff_tasks (status, due_at);

create or replace function public.staff_tasks_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists staff_tasks_touch on public.staff_tasks;
create trigger staff_tasks_touch before update on public.staff_tasks
  for each row execute function public.staff_tasks_touch();

alter table public.staff_tasks enable row level security;

drop policy if exists staff_tasks_admin_all on public.staff_tasks;
create policy staff_tasks_admin_all on public.staff_tasks
  for all to authenticated
  using (public.is_booking_staff()) with check (public.is_booking_staff());

-- Viewers see tasks meant for everyone and tasks meant for them.
drop policy if exists staff_tasks_member_read on public.staff_tasks;
create policy staff_tasks_member_read on public.staff_tasks
  for select to authenticated
  using (public.is_booking_member()
         and (assigned_to is null or assigned_to = lower(coalesce(auth.jwt() ->> 'email', ''))));

grant select, insert, update, delete on public.staff_tasks to authenticated;

-- Viewers cannot edit a task. They can only mark one done, through this.
create or replace function public.complete_staff_task(
  p_task uuid, p_note text default null, p_proof_path text default null, p_proof_type text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_booking_member() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_proof_path is not null and p_proof_path not like 'tasks/' || p_task::text || '/%' then
    raise exception 'proof must be stored under this task' using errcode = '22023';
  end if;
  update public.staff_tasks
     set status = 'done', done_at = now(), done_by = me,
         done_note  = nullif(btrim(coalesce(p_note, '')), ''),
         proof_path = p_proof_path,
         proof_type = case when p_proof_path is null then null else p_proof_type end
   where id = p_task and status = 'open'
     and (assigned_to is null or assigned_to = me or public.is_booking_staff());
  if not found then
    raise exception 'task not found, not yours, or already done' using errcode = 'P0002';
  end if;
end $$;
revoke all on function public.complete_staff_task(uuid, text, text, text) from public;
grant execute on function public.complete_staff_task(uuid, text, text, text) to authenticated;


-- ----------------------------------------------------- push subscriptions --
-- One row per device that agreed to receive notifications.
create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  email       text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_email on public.push_subscriptions (email);

alter table public.push_subscriptions enable row level security;

-- Only admins read these, because only admins send notifications.
drop policy if exists push_subscriptions_admin on public.push_subscriptions;
create policy push_subscriptions_admin on public.push_subscriptions
  for all to authenticated
  using (public.is_booking_staff()) with check (public.is_booking_staff());
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- A tablet registers itself through this; it takes the device over if another
-- account used it before, which is what you want when tablets change hands.
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_booking_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint' using errcode = '22023'; end if;
  insert into public.push_subscriptions (endpoint, email, p256dh, auth, user_agent)
  values (p_endpoint, me, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, created_at = now();
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions
   where endpoint = p_endpoint and email = lower(coalesce(auth.jwt() ->> 'email', ''));
end $$;
revoke all on function public.remove_push_subscription(text) from public;
grant execute on function public.remove_push_subscription(text) to authenticated;


-- ------------------------------------------------------ proof photo store --
-- A private bucket. Kept in its own guarded block: Supabase restricts some
-- operations on its storage tables, and if this part is refused it must not
-- undo everything above. If it is skipped, the table at the bottom says so.
do $$
begin
  begin
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('task-proof', 'task-proof', false, 52428800, array['image/*', 'video/*'])
    on conflict (id) do update
       set public = false, file_size_limit = excluded.file_size_limit,
           allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists mic_proof_insert on storage.objects';
    execute $p$create policy mic_proof_insert on storage.objects for insert to authenticated
             with check (bucket_id = 'task-proof' and public.is_booking_member())$p$;
    execute 'drop policy if exists mic_proof_read on storage.objects';
    execute $p$create policy mic_proof_read on storage.objects for select to authenticated
             using (bucket_id = 'task-proof' and public.is_booking_member())$p$;
    execute 'drop policy if exists mic_proof_delete on storage.objects';
    execute $p$create policy mic_proof_delete on storage.objects for delete to authenticated
             using (bucket_id = 'task-proof' and public.is_booking_staff())$p$;
  exception when others then
    raise notice 'Proof storage step was skipped: %', sqlerrm;
  end;
end $$;


-- ----------------------------------------------------------------- status --
select part, status from (values
  (1, 'Staff roles',
      case when exists (select 1 from public.booking_staff where role = 'admin' and active)
           then 'ready' else 'MISSING' end),
  (2, 'Staff can view bookings',
      case when exists (select 1 from pg_policies where tablename = 'room_bookings'
                        and policyname = 'room_bookings_member_read') then 'ready' else 'MISSING' end),
  (3, 'Tasks',
      case when to_regclass('public.staff_tasks') is not null then 'ready' else 'MISSING' end),
  (4, 'Push notifications',
      case when to_regclass('public.push_subscriptions') is not null then 'ready' else 'MISSING' end),
  (5, 'Proof photos and videos',
      case when exists (select 1 from pg_policies where schemaname = 'storage'
                        and policyname = 'mic_proof_insert')
           then 'ready' else 'NOT SET UP — send Claude a screenshot' end)
) as t(n, part, status) order by n;
