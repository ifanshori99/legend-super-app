CREATE TABLE "new_child" ("id" text PRIMARY KEY, "parent_id" text);
ALTER TABLE "new_child" ADD CONSTRAINT "new_child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id");
