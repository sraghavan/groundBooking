CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"upi_id" text,
	"holder_name" text,
	"details" text,
	"qr_image" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "event_type" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "match_count" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "kind" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "default_rate" integer;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_accounts_org_idx" ON "payment_accounts" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_payment_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data: the single UPI ID in settings becomes the first (default) payment account.
INSERT INTO "payment_accounts" ("org_id", "name", "upi_id", "is_default")
SELECT "id", 'Main account', "settings"->>'upiId', true FROM "orgs" WHERE coalesce("settings"->>'upiId', '') <> '';--> statement-breakpoint
-- Data: promoters Rana and Ravinder. An existing team with that name becomes the promoter (keeps its history).
UPDATE "teams" SET "kind" = 'promoter' WHERE "name_key" IN ('rana', 'ravinder');--> statement-breakpoint
INSERT INTO "teams" ("org_id", "name", "name_key", "kind")
SELECT o."id", p."name", p."key", 'promoter' FROM "orgs" o
CROSS JOIN (VALUES ('Rana', 'rana'), ('Ravinder', 'ravinder')) AS p("name", "key")
WHERE NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."org_id" = o."id" AND t."name_key" = p."key");--> statement-breakpoint
-- Data: whole-slot holds by a promoter (imported as events) become promoter bookings.
UPDATE "bookings" b SET "kind" = 'promoter', "title" = NULL
WHERE b."kind" = 'event'
  AND (SELECT count(*) FROM "booking_parties" bp WHERE bp."booking_id" = b."id") = 1
  AND EXISTS (SELECT 1 FROM "booking_parties" bp JOIN "teams" t ON t."id" = bp."team_id" WHERE bp."booking_id" = b."id" AND t."kind" = 'promoter');
