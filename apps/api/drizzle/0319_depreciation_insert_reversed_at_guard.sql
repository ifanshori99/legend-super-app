-- Second-opinion finding 4 on 0313: fixed_asset_depreciations_active_key only
-- indexes rows WHERE reversed_at IS NULL, so an INSERT that already carries a
-- reversed_at sat outside the index and could duplicate an asset month. A row
-- is born active; reversed_at is set only by app.record_depreciation_reversal
-- (an UPDATE). The trigger also holds for the table owner.
CREATE FUNCTION app.assert_depreciation_born_active() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a depreciation row is born active; reversed_at is set only by the reversal function (DEPRECIATION_INSERT_REVERSED)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fixed_asset_depreciations_born_active
BEFORE INSERT ON public.fixed_asset_depreciations
FOR EACH ROW EXECUTE FUNCTION app.assert_depreciation_born_active();
