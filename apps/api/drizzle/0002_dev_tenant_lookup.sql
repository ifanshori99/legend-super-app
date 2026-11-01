-- Bootstrap-only synthetic lookup. No production domain resolver is installed.
CREATE TABLE app.dev_tenant_lookup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tenant_id uuid NOT NULL,
  brand_id uuid
);
--> statement-breakpoint
GRANT SELECT ON app.dev_tenant_lookup TO legend_app;
