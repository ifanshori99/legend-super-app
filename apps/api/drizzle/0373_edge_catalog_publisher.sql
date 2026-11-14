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
-- legend-3k41y: the version of a printer deletion the edge applied (HTTP pull or
-- live event). A printer row is hard-deleted on the edge, so without this row a
-- later, older live event would bring it back. Only a version above it may.
CREATE TABLE edge_printer_delete_versions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  printer_id uuid NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, printer_id),
  CONSTRAINT edge_printer_delete_versions_outlet_fk FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets (tenant_id, id)
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_printer_delete_versions'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_printer_delete_versions'::regclass);
--> statement-breakpoint
ALTER TABLE edge_inbound_events DROP CONSTRAINT edge_inbound_events_outcome_check;
--> statement-breakpoint
ALTER TABLE edge_inbound_events ADD CONSTRAINT edge_inbound_events_outcome_check CHECK (outcome IN ('applied','superseded','conflict','deferred')) NOT VALID;

--> statement-breakpoint
-- legend-3k41y: pending catalog rows of a node whose outlet brand moved are
-- copied whole into edge_link_dead_letters (reason brand_moved) and replaced in
-- place by an edge_link.dead_lettered placeholder on the same link_seq. The
-- queue is never renumbered, so the 0352 guards (app.edge_dead_letter marker,
-- dead-letter copy required for a delete) stay unchanged.
ALTER TABLE edge_link_dead_letters DROP CONSTRAINT edge_link_dead_letters_reason_check;
--> statement-breakpoint
ALTER TABLE edge_link_dead_letters ADD CONSTRAINT edge_link_dead_letters_reason_check CHECK (reason IN ('frame_too_large', 'brand_moved')) NOT VALID;
