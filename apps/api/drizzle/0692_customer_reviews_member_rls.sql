-- 1081 (legend-7jrh7): 0455 put customer_reviews under tenant and outlet RLS
-- but never called app.enforce_member_rls, although the table carries a
-- nullable customer_profile_id like every other member-owned table. Add the
-- RESTRICTIVE member_self policy so a signed-in member only sees rows that
-- belong to their own profile (rows with no profile stay staff-only). 0455 is
-- applied and stays untouched; tenant RLS FORCE already exists from 0455.
SELECT app.enforce_member_rls('public.customer_reviews'::regclass);
