CREATE TABLE edge_catalog_publisher_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  edge_node_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  stream varchar(40) NOT NULL,
  watermark text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz,
  PRIMARY KEY (tenant_id, edge_node_id, stream),
  CONSTRAINT edge_catalog_publisher_cursors_edge_node_fk FOREIGN KEY (tenant_id, outlet_id, edge_node_id) REFERENCES edge_nodes (tenant_id, outlet_id, id)
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_catalog_publisher_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_publisher_cursors'::regclass);
--> statement-breakpoint
ALTER TABLE edge_inbound_events DROP CONSTRAINT edge_inbound_events_outcome_check;
--> statement-breakpoint
ALTER TABLE edge_inbound_events ADD CONSTRAINT edge_inbound_events_outcome_check CHECK (outcome IN ('applied','superseded','conflict','deferred')) NOT VALID;
