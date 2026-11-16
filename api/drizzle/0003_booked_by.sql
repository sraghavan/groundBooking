ALTER TABLE "bookings" ADD COLUMN "booked_by" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
-- Promoter bookings were a separate kind; they are matches held by a promoter.
UPDATE "bookings" SET "booked_by" = 'promoter', "kind" = 'match' WHERE "kind" = 'promoter';
