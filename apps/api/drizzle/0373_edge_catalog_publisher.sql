CREATE TABLE edge_catalog_publisher_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  edge_node_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  stream varchar(40) NOT NULL,
  watermark text,
  PRIMARY KEY (tenant_id, edge_node_id, stream),
  CONSTRAINT edge_catalog_publisher_cursors_edge_node_fk FOREIGN KEY (tenant_id, outlet_id, edge_node_id) REFERENCES edge_nodes (tenant_id, outlet_id, id)
);
--> statement-breakpoint
SELECT app.enforce_tenant_rls('public.edge_catalog_publisher_cursors'::regclass);
--> statement-breakpoint
SELECT app.enforce_outlet_rls('public.edge_catalog_publisher_cursors'::regclass);
