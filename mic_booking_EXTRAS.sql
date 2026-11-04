-- ============================================================================
-- MIC room booking — catering and extras catalogue
--
-- Run once in the Supabase SQL editor, AFTER mic_booking_SETUP.sql.
-- Safe to re-run: it will not duplicate the starter rows.
--
-- One table holds everything you can offer alongside a room:
--   package   a ready-made catering tier, picked on its own
--   item      a single catering line, for building your own
--   extra     equipment or a service: a screen, a sound system, early access
--
-- You edit all of it from the booking console, not from here. This file only
-- creates the table and fills it with what the site offers today.
-- ============================================================================

create table if not exists public.booking_addons (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  kind        text not null check (kind in ('package','item','extra')),
  name        text not null,
  description text,

  -- price null means "we will quote it", which is how a special order works
  price       numeric(10,2) check (price is null or price >= 0),
  unit        text not null default 'per_person'
                check (unit in ('per_person','flat','per_hour')),

  active      boolean not null default true,
  sort        integer not null default 100
);

create index if not exists booking_addons_pick
  on public.booking_addons (kind, active, sort);

-- What a booking actually asked for, frozen at the time it was made, so a
-- later price change never rewrites an old booking.
alter table public.room_bookings
  add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.room_bookings
  add column if not exists addons_note text;

-- ---------------------------------------------------------------- security --
alter table public.booking_addons enable row level security;
alter table public.booking_addons force row level security;

-- The public may read the live menu, and nothing else.
drop policy if exists booking_addons_public_read on public.booking_addons;
create policy booking_addons_public_read
  on public.booking_addons for select
  to anon
  using (active = true);

-- Staff, and only the staff named in mic_booking_SETUP.sql, may change it.
drop policy if exists booking_addons_staff_all on public.booking_addons;
create policy booking_addons_staff_all
  on public.booking_addons for all
  to authenticated
  using (public.is_booking_staff())
  with check (public.is_booking_staff());

grant select on public.booking_addons to anon;
grant select, insert, update, delete on public.booking_addons to authenticated;

-- ------------------------------------------------------------ starter menu --
-- Only inserted the first time, so re-running leaves your edits alone.
insert into public.booking_addons (kind, name, description, price, unit, sort)
select * from (values
  ('package','Refreshments','Coffee, tea and water throughout the session.', 3.00,'per_person',10),
  ('package','Coffee break','Refreshments plus sweet and salty bites.',       5.00,'per_person',20),
  ('package','Premium coffee break','A fuller spread, served mid-session.',  10.00,'per_person',30),
  ('package','Meal break','Breakfast, lunch or dinner. We quote it with your confirmation.',
                                                                              null,'per_person',40),

  ('item','Coffee and tea',       null, 2.00,'per_person',10),
  ('item','Bottled water',        null, 1.00,'per_person',20),
  ('item','Fresh juice',          null, 2.50,'per_person',30),
  ('item','Sweet bites',          null, 2.50,'per_person',40),
  ('item','Salty bites',          null, 2.50,'per_person',50),
  ('item','Fresh fruit',          null, 3.00,'per_person',60),

  ('extra','Early access','One hour before your session to set up.',          0.00,'flat',10),
  ('extra','Screen and HDMI',  'Wall screen with an HDMI cable.',             0.00,'flat',20),
  ('extra','Adapter cables',   'USB-C, Mini DisplayPort and Lightning.',      0.00,'flat',30),
  ('extra','Sound system and microphones', 'Two handheld microphones.',       0.00,'flat',40),
  ('extra','Flipchart and markers', null,                                     0.00,'flat',50),
  ('extra','Whiteboard',       null,                                          0.00,'flat',60),
  ('extra','Printing',         'Handouts printed in advance. We quote per job.',
                                                                              null,'flat',70)
) as v(kind, name, description, price, unit, sort)
where not exists (select 1 from public.booking_addons);

-- ---------------------------------------------------------------- check ----
--   select kind, name, price, unit, active from booking_addons order by kind, sort;
