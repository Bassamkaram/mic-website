-- ============================================================================
-- MIC room booking — schema, security and availability
-- Run once in the Supabase SQL editor (project xnegzvpuagxgahlbtzaf).
-- Safe to re-run: every statement is idempotent.
--
-- Creates:
--   room_bookings      every request, waitlist entry and manual block
--   room_availability  a PUBLIC view of which slots are taken, with no
--                      personal data in it at all
--
-- Security model
--   The anon key in booking.html is public by design. So the public may
--   INSERT a request and may read the availability view, and nothing else.
--   It cannot read anyone's name, email or phone, and it cannot create a
--   booking that is already confirmed. Confirming is staff-only.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- table ----
create table if not exists public.room_bookings (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null default gen_random_uuid(),  -- groups the slots of one submission
  created_at       timestamptz not null default now(),

  room             text not null check (room in ('meeting','workshop')),
  booking_date     date not null,
  -- meeting room: '00'..'23' (the hour it starts).  workshop room: 'am' | 'pm'
  slot             text not null,

  status           text not null default 'pending'
                     check (status in ('pending','confirmed','rejected','cancelled','blocked')),
  kind             text not null default 'booking'
                     check (kind in ('booking','waitlist')),

  -- who is asking
  name             text,
  email            text,
  phone            text,
  org              text,

  headcount        integer check (headcount is null or headcount between 1 and 40),
  setup            text check (setup is null or setup in ('ushape','classroom')),

  catering         text not null default 'none'
                     check (catering in ('none','refreshments','coffee_break','premium','meal')),
  catering_people  integer check (catering_people is null or catering_people between 1 and 40),
  catering_quote   numeric(10,2),        -- what the page quoted; null for 'meal' (on request)

  notes            text,
  admin_note       text
);

-- A confirmed or blocked slot is exclusive: this makes double-booking
-- impossible at the database level, not merely in the page.
create unique index if not exists room_bookings_slot_taken
  on public.room_bookings (room, booking_date, slot)
  where status in ('confirmed','blocked');

create index if not exists room_bookings_lookup
  on public.room_bookings (room, booking_date);
create index if not exists room_bookings_request
  on public.room_bookings (request_id);
create index if not exists room_bookings_triage
  on public.room_bookings (status, created_at desc);

-- Capacity, enforced in the database as well as the page.
-- meeting room 15; workshop room 30 u-shape, 40 classroom.
alter table public.room_bookings drop constraint if exists room_bookings_capacity;
alter table public.room_bookings add constraint room_bookings_capacity check (
  headcount is null
  or (room = 'meeting'  and headcount <= 15)
  or (room = 'workshop' and setup = 'ushape'    and headcount <= 30)
  or (room = 'workshop' and setup = 'classroom' and headcount <= 40)
  or (room = 'workshop' and setup is null       and headcount <= 40)
);

-- Slot values must match the room they belong to.
alter table public.room_bookings drop constraint if exists room_bookings_slot_shape;
alter table public.room_bookings add constraint room_bookings_slot_shape check (
  (room = 'meeting'  and slot ~ '^(0[0-9]|1[0-9]|2[0-3])$')
  or (room = 'workshop' and slot in ('am','pm'))
);

-- ------------------------------------------------------------ public view --
-- The only thing the public may read. Columns are deliberately limited to
-- what a calendar needs; there is no way to reach a person's details through
-- it. It runs with the owner's rights, so RLS on the base table does not
-- hide the rows from anon.
create or replace view public.room_availability
  with (security_invoker = false) as
select room, booking_date, slot
from   public.room_bookings
where  status in ('confirmed','blocked');

-- --------------------------------------------------------------- row level --
alter table public.room_bookings enable row level security;
alter table public.room_bookings force row level security;

-- Anyone may lodge a request, but only ever as a pending one, and never as a
-- manual block. Everything staff-only is refused here.
drop policy if exists room_bookings_public_insert on public.room_bookings;
create policy room_bookings_public_insert
  on public.room_bookings for insert
  to anon
  with check (
    status = 'pending'
    and kind in ('booking','waitlist')
    and admin_note is null
  );

-- Deliberately no SELECT, UPDATE or DELETE policy for anon: with RLS on,
-- absent policy means denied, so the public cannot read the table at all.

drop policy if exists room_bookings_staff_all on public.room_bookings;
create policy room_bookings_staff_all
  on public.room_bookings for all
  to authenticated
  using (true) with check (true);

-- ------------------------------------------------------------------ grants --
grant usage on schema public to anon, authenticated;
grant insert on public.room_bookings to anon;
grant select, insert, update, delete on public.room_bookings to authenticated;
grant select on public.room_availability to anon, authenticated;

-- The public must not be able to read the table even if a policy is added
-- later by accident.
revoke select, update, delete on public.room_bookings from anon;
