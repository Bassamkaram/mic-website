-- ============================================================================
-- MIC room booking — restrict the staff console to named people
--
-- Run this AFTER mic_booking_2026-11-02.sql, in the Supabase SQL editor.
-- Safe to re-run, and safe to re-run after editing the email list.
--
-- Why
--   The first migration granted booking access to the "authenticated" role,
--   which is every signed-in user of this Supabase project. If that project
--   also holds platform members, event registrants or any other non-staff
--   account, each of them could read the name, email and phone of everyone
--   who books a room, and could confirm or reject bookings.
--
--   This replaces that with an explicit list. Someone must be signed in AND
--   on the list. Everyone else is refused by the database, so it does not
--   matter what page they use to ask.
--
-- EDIT THE LIST BELOW before running: put in the staff who should be able to
-- approve bookings, exactly as their email appears in Supabase Auth → Users.
-- ============================================================================

create or replace function public.is_booking_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in (
    -- ⬇⬇ EDIT THIS LIST ⬇⬇
    'info@mic-lb.com',
    'bassamkaram@gmail.com'
    -- ⬆⬆ one quoted email per line, commas between, no comma after the last
  );
$$;

revoke all on function public.is_booking_staff() from public;
grant execute on function public.is_booking_staff() to authenticated;

drop policy if exists room_bookings_staff_all on public.room_bookings;
create policy room_bookings_staff_all
  on public.room_bookings for all
  to authenticated
  using (public.is_booking_staff())
  with check (public.is_booking_staff());

-- The public insert policy is unchanged: anyone may still lodge a pending
-- request, and still cannot read anything back.

-- ---------------------------------------------------------------- check ----
-- After running, this should return true for you and false for anyone else:
--   select public.is_booking_staff();
