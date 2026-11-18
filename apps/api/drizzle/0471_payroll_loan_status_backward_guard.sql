-- legend-rtrbj (architect review of 0469): the principal guard of 0469 only looks
-- at the OLD status, so a loan could be walked back from `disbursed` to
-- `pending`, edited there and moved forward again inside one transaction. No
-- application path ever leaves `disbursed`/`settled`, so the database now
-- refuses it: a loan that was paid out never goes back to an earlier status.
CREATE OR REPLACE FUNCTION app.employee_loans_status_backward_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'PAYR-03: loan % was paid out and cannot go back to status %', NEW.id, NEW.status
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER employee_loans_status_backward_trg BEFORE UPDATE OF status ON public.employee_loans FOR EACH ROW WHEN (OLD.status IN ('disbursed', 'settled') AND NEW.status NOT IN ('disbursed', 'settled')) EXECUTE FUNCTION app.employee_loans_status_backward_guard();
