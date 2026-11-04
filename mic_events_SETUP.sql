-- ============================================================================
-- MIC Event Space — facilities for events, booked by the hour
--
-- Paste the whole of this into the Supabase SQL editor and press Run, once,
-- after the earlier booking files. Safe to run again at any time.
-- The last thing it does is print a short table telling you what is ready.
--
-- An event uses one or more facilities. Each facility is booked like a room,
-- by the hour, so the calendar, the console and the staff tablet all work the
-- same way for events as for rooms:
--
--   ev_cowork      Open coworking space
--   ev_workshop    Workshop room, for an event (the same room as half-day workshops)
--   ev_play_full   Outdoor playground, all of it
--   ev_play_part   Outdoor playground, part of it (two events may each have a part)
--   ev_kitchen     Kitchen area
--   ev_coffee      Coffee shop
--
-- The rules live in the database, so no page and no person can break them:
--   · each facility hosts one event at a time
--   · the playground holds two "part" events at once, or one "full" one
--   · an event in the workshop room blocks a half-day workshop over those
--     hours (08:00–14:00 morning, 14:00–20:00 afternoon), and the other way round
--   · "Partnership with MIC" and "Free of charge" can only be set by an admin
-- ============================================================================


-- ------------------------------------------------------- rooms and slots --
alter table public.room_bookings drop constraint if exists room_bookings_room_check;
alter table public.room_bookings add constraint room_bookings_room_check check (room in (
  'meeting', 'workshop',
  'ev_cowork', 'ev_workshop', 'ev_play_full', 'ev_play_part', 'ev_kitchen', 'ev_coffee'));

-- the workshop room is booked by the half-day; everything else by the hour
alter table public.room_bookings drop constraint if exists room_bookings_slot_shape;
alter table public.room_bookings add constraint room_bookings_slot_shape check (
  (room = 'workshop' and slot in ('am','pm'))
  or (room <> 'workshop' and slot ~ '^(0[0-9]|1[0-9]|2[0-3])$')
);

-- events can be bigger than a room; rooms keep their limits
alter table public.room_bookings drop constraint if exists room_bookings_headcount_check;
alter table public.room_bookings add constraint room_bookings_headcount_check
  check (headcount is null or headcount between 1 and 1000);
alter table public.room_bookings drop constraint if exists room_bookings_catering_people_check;
alter table public.room_bookings add constraint room_bookings_catering_people_check
  check (catering_people is null or catering_people between 1 and 1000);
alter table public.room_bookings drop constraint if exists room_bookings_capacity;
alter table public.room_bookings add constraint room_bookings_capacity check (
  headcount is null
  or (room = 'meeting'  and headcount <= 15)
  or (room = 'workshop' and setup = 'ushape'    and headcount <= 30)
  or (room = 'workshop' and setup = 'classroom' and headcount <= 40)
  or (room = 'workshop' and setup is null       and headcount <= 40)
  or room like 'ev\_%'
);


-- ------------------------------------------------------- event details --
alter table public.room_bookings add column if not exists event_name     text;
alter table public.room_bookings add column if not exists partnership    boolean not null default false;
alter table public.room_bookings add column if not exists free_of_charge boolean not null default false;
alter table public.room_bookings drop constraint if exists room_bookings_free_needs_partner;
alter table public.room_bookings add constraint room_bookings_free_needs_partner
  check (not free_of_charge or partnership);


-- ----------------------------------------------------- one at a time ----
-- A confirmed or blocked hour is exclusive per facility, except a part of the
-- playground, which the rule below allows twice.
drop index if exists public.room_bookings_slot_taken;
create unique index room_bookings_slot_taken
  on public.room_bookings (room, booking_date, slot)
  where status in ('confirmed','blocked') and room <> 'ev_play_part';

create or replace function public.room_bookings_event_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  h int := case when new.slot ~ '^[0-9]{2}$' then new.slot::int end;
begin
  if new.status not in ('confirmed','blocked') then return new; end if;

  -- one decision per day at a time, so two people confirming at once cannot both win
  perform pg_advisory_xact_lock(hashtext('mic-room-bookings'), hashtext(new.booking_date::text));

  if new.room = 'ev_play_part' then
    if exists (select 1 from room_bookings b
                where b.room = 'ev_play_full' and b.booking_date = new.booking_date and b.slot = new.slot
                  and b.status in ('confirmed','blocked'))
       or (select count(*) from room_bookings b
            where b.room = 'ev_play_part' and b.booking_date = new.booking_date and b.slot = new.slot
              and b.status in ('confirmed','blocked') and b.id <> new.id) >= 2 then
      raise exception 'The outdoor playground is already fully booked at %:00 on %.', new.slot, new.booking_date
        using errcode = '23505';
    end if;

  elsif new.room = 'ev_play_full' then
    if exists (select 1 from room_bookings b
                where b.room = 'ev_play_part' and b.booking_date = new.booking_date and b.slot = new.slot
                  and b.status in ('confirmed','blocked') and b.id <> new.id) then
      raise exception 'Part of the outdoor playground is already booked at %:00 on %.', new.slot, new.booking_date
        using errcode = '23505';
    end if;

  elsif new.room = 'ev_workshop' then
    if exists (select 1 from room_bookings b
                where b.room = 'workshop' and b.booking_date = new.booking_date
                  and b.status in ('confirmed','blocked')
                  and ((b.slot = 'am' and h >= 8 and h < 14) or (b.slot = 'pm' and h >= 14 and h < 20))) then
      raise exception 'The workshop room has a workshop booked at %:00 on %.', new.slot, new.booking_date
        using errcode = '23505';
    end if;

  elsif new.room = 'workshop' then
    if exists (select 1 from room_bookings b
                where b.room = 'ev_workshop' and b.booking_date = new.booking_date
                  and b.status in ('confirmed','blocked')
                  and case when b.slot ~ '^[0-9]{2}$' then
                        (new.slot = 'am' and b.slot::int >= 8 and b.slot::int < 14)
                        or (new.slot = 'pm' and b.slot::int >= 14 and b.slot::int < 20)
                      else false end) then
      raise exception 'The workshop room has an event booked during that half-day on %.', new.booking_date
        using errcode = '23505';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists room_bookings_event_rules on public.room_bookings;
create trigger room_bookings_event_rules
  before insert or update of status, room, slot, booking_date on public.room_bookings
  for each row execute function public.room_bookings_event_rules();


-- ---------------------------------------------------- admins only ----
-- The public may still send requests, but never marked as a partnership or
-- free. A restrictive policy is added on top of the existing one, so it holds
-- even if the first setup file is run again later.
drop policy if exists room_bookings_public_no_partner on public.room_bookings;
create policy room_bookings_public_no_partner
  on public.room_bookings as restrictive for insert
  to anon
  with check (partnership = false and free_of_charge = false);


-- ------------------------------------------ prices, set in the console ----
-- Each facility is a line in the Catering & extras tab, priced per hour.
-- An empty price means "on request", which is where they all start.
alter table public.booking_addons drop constraint if exists booking_addons_kind_check;
alter table public.booking_addons add constraint booking_addons_kind_check
  check (kind in ('package','item','extra','facility'));
alter table public.booking_addons add column if not exists code text;
create unique index if not exists booking_addons_code on public.booking_addons (code) where code is not null;

insert into public.booking_addons (kind, code, name, description, price, unit, sort)
select v.kind, v.code, v.name, v.description, v.price, v.unit, v.sort from (values
  ('facility', 'ev_cowork',    'Open coworking space',            'The open space on the ground floor.',       null::numeric, 'per_hour', 10),
  ('facility', 'ev_workshop',  'Workshop room',                   'Up to 40 people, with screen and sound.',   null::numeric, 'per_hour', 20),
  ('facility', 'ev_play_full', 'Outdoor playground, all of it',   null,                                        null::numeric, 'per_hour', 30),
  ('facility', 'ev_play_part', 'Outdoor playground, part of it',  'Shared with at most one other event.',      null::numeric, 'per_hour', 40),
  ('facility', 'ev_kitchen',   'Kitchen area',                    null,                                        null::numeric, 'per_hour', 50),
  ('facility', 'ev_coffee',    'Coffee shop',                     null,                                        null::numeric, 'per_hour', 60)
) as v(kind, code, name, description, price, unit, sort)
where not exists (select 1 from public.booking_addons a where a.code = v.code);


-- ----------------------------------------------------------------- status --
select part, status from (values
  (1, 'Event facilities can be booked',
      case when exists (select 1 from pg_constraint where conname = 'room_bookings_room_check'
                        and pg_get_constraintdef(oid) like '%ev_play_part%') then 'ready' else 'MISSING' end),
  (2, 'One event per facility at a time',
      case when exists (select 1 from pg_trigger where tgname = 'room_bookings_event_rules') then 'ready' else 'MISSING' end),
  (3, 'Partnership and free: admins only',
      case when exists (select 1 from pg_policies where policyname = 'room_bookings_public_no_partner') then 'ready' else 'MISSING' end),
  (4, 'Facility prices in Catering & extras',
      case when (select count(*) from public.booking_addons where kind = 'facility') >= 6 then 'ready' else 'MISSING' end)
) as t(n, part, status) order by n;
