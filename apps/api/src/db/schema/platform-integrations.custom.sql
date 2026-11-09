-- Cross-tenant WhatsApp number claim (bead legend-mbd2; PRD §3 F4 Integrasi
-- per Tenant, §3 F6, AUTH-02). Folded into migration 0178 BEFORE the two
-- `tenant_integrations_whatsapp_*_key` indexes drizzle generates, because
-- the index expressions call these functions.
--
-- Both functions mirror TypeScript exactly, so the database and the login
-- flow agree on what "the same number" means:
-- - app.normalize_wa_number = normalizeWhatsAppNumber
--   (packages/shared/src/identity/login-code.ts): digits only, no plus, no
--   separators, a leading 0 becomes 62, then 8..15 digits starting 1-9.
-- - app.whatsapp_receiving_number / app.whatsapp_routing_key =
--   resolveWhatsAppChannel (identity-login.service.ts): configText() keeps a
--   trimmed non-empty string or a finite number; routing is phoneNumberId
--   when set, otherwise the normalized receiving number.
-- The whitespace class is the explicit set JS `\s`/trim() strips (POSIX
-- [[:space:]] misses U+00A0, U+FEFF, U+1680, U+2007, U+202F and more).
-- IMMUTABLE + pinned search_path so they are valid index expressions.

CREATE OR REPLACE FUNCTION app.normalize_wa_number(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN d ~ '^[1-9][0-9]{7,14}$' THEN d END
  FROM (
    SELECT CASE WHEN s ~ '^0' THEN '62' || substr(s, 2) ELSE s END AS d
    FROM (
      SELECT regexp_replace(
        regexp_replace(coalesce(input, ''), '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\-().]', '', 'g'),
        '^\+', ''
      ) AS s
    ) cleaned
  ) international
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.whatsapp_config_text(config jsonb, key text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE jsonb_typeof(config -> key)
    WHEN 'string' THEN nullif(
      regexp_replace(config ->> key, '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'),
      ''
    )
    WHEN 'number' THEN config ->> key
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.whatsapp_receiving_number(config jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT app.normalize_wa_number(app.whatsapp_config_text(config, 'receivingNumber'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.whatsapp_routing_key(config jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT coalesce(
    app.whatsapp_config_text(config, 'phoneNumberId'),
    app.whatsapp_receiving_number(config)
  )
$$;
--> statement-breakpoint

-- Existing data: two tenants may already share a number. Creating the unique
-- index would then fail with a bare "could not create unique index". Fail
-- first with the tenants named, so the operator can disable the wrong row
-- (UPDATE tenant_integrations SET status = 'disabled' WHERE id = ...) and
-- rerun. Never silently pick a winner: either tenant may be the real owner.
DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(format('%s=%s (integrations %s)', kind, key, ids), '; ')
  INTO clash
  FROM (
    SELECT 'receivingNumber' AS kind, app.whatsapp_receiving_number(config) AS key,
           string_agg(id::text, ', ' ORDER BY id) AS ids
    FROM public.tenant_integrations
    WHERE provider = 'whatsapp' AND status = 'active' AND outlet_id IS NULL
      AND app.whatsapp_receiving_number(config) IS NOT NULL
    GROUP BY 2 HAVING count(*) > 1
    UNION ALL
    SELECT 'routing', app.whatsapp_routing_key(config),
           string_agg(id::text, ', ' ORDER BY id)
    FROM public.tenant_integrations
    WHERE provider = 'whatsapp' AND status = 'active' AND outlet_id IS NULL
      AND app.whatsapp_routing_key(config) IS NOT NULL
    GROUP BY 2 HAVING count(*) > 1
  ) duplicates;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'legend-mbd2: active WhatsApp integrations of different tenants share a number: %', clash
      USING ERRCODE = '23505',
            HINT = 'Disable all but the real owner (status = ''disabled'') and rerun the migration.';
  END IF;
END
$$;
