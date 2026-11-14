CREATE TABLE "new_child" (
  "id" text PRIMARY KEY,
  "parent_id" text,
  CONSTRAINT "new_child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id")
);
ALTER TABLE "existing_child" ADD CONSTRAINT "existing_child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") NOT VALID;
