ALTER TABLE "bots"
ADD COLUMN "additionalInstructions" TEXT NOT NULL DEFAULT '';

UPDATE "bots"
SET "name" = 'AIMEE'
WHERE "managedByBrandWell" = true
  AND "name" IN ('BrandWell''s AIMEE', 'BrandWell’s AIMEE');
