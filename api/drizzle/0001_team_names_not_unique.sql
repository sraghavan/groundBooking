DROP INDEX "teams_org_key_uq";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "teams_org_key_idx" ON "teams" USING btree ("org_id","name_key");