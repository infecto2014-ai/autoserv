ALTER TABLE WorkOrder ADD COLUMN financialMode TEXT NOT NULL DEFAULT 'WORKFLOW'
  CHECK (financialMode IN ('WORKFLOW','LEGACY'));
--> statement-breakpoint
UPDATE WorkOrder SET financialMode = 'LEGACY';
--> statement-breakpoint
ALTER TABLE OrderLine ADD COLUMN approval TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (approval IN ('PENDING','APPROVED','DEFERRED'));
--> statement-breakpoint
ALTER TABLE OrderLine ADD COLUMN completed INTEGER NOT NULL DEFAULT 0
  CHECK (completed IN (0,1));
--> statement-breakpoint
ALTER TABLE OrderLine ADD COLUMN partSource TEXT NOT NULL DEFAULT 'SERVICE'
  CHECK (partSource IN ('SERVICE','CUSTOMER'));
--> statement-breakpoint
CREATE TABLE LegacyFinancialSnapshot (
  orderId TEXT PRIMARY KEY NOT NULL REFERENCES WorkOrder(id) ON DELETE RESTRICT,
  laborCents INTEGER NOT NULL, partsCents INTEGER NOT NULL, subtotalCents INTEGER NOT NULL,
  discountCents INTEGER NOT NULL, totalCents INTEGER NOT NULL, paidCents INTEGER NOT NULL,
  balanceCents INTEGER NOT NULL, overpaidCents INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
-- В прежнем расчёте каждая строка округлялась до копейки до сложения.
WITH lineAmounts AS (
  SELECT orderId, kind, (quantityMilli * unitPriceCents + 500) / 1000 AS cents FROM OrderLine
), components AS (
  SELECT orderId,
    sum(CASE WHEN kind = 'LABOR' THEN cents ELSE 0 END) AS laborCents,
    sum(CASE WHEN kind = 'PART' THEN cents ELSE 0 END) AS partsCents
  FROM lineAmounts GROUP BY orderId
), orders AS (
  SELECT w.id, coalesce(c.laborCents, 0) AS labor, coalesce(c.partsCents, 0) AS parts,
    w.discountCents AS discount, w.paidCents AS paid
  FROM WorkOrder AS w LEFT JOIN components AS c ON c.orderId = w.id
)
INSERT INTO LegacyFinancialSnapshot
  (orderId,laborCents,partsCents,subtotalCents,discountCents,totalCents,paidCents,balanceCents,overpaidCents)
SELECT id, labor, parts, labor + parts, discount, labor + parts - discount, paid,
  max(0, labor + parts - discount - paid), max(0, paid - (labor + parts - discount))
FROM orders;
--> statement-breakpoint
CREATE TABLE Payment (
  id TEXT PRIMARY KEY NOT NULL,
  orderId TEXT NOT NULL REFERENCES WorkOrder(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('OPENING','PAYMENT','REFUND')),
  amountCents INTEGER NOT NULL CHECK (amountCents BETWEEN 1 AND 9007199254740991),
  laborCents INTEGER NOT NULL CHECK (laborCents BETWEEN 0 AND amountCents),
  partsCents INTEGER NOT NULL CHECK (partsCents BETWEEN 0 AND amountCents),
  unallocatedCents INTEGER NOT NULL CHECK (unallocatedCents BETWEEN 0 AND amountCents),
  occurredAt TEXT,
  actorId TEXT REFERENCES User(id) ON DELETE RESTRICT,
  relatedPaymentId TEXT,
  reason TEXT,
  UNIQUE(orderId,id),
  FOREIGN KEY(orderId,relatedPaymentId) REFERENCES Payment(orderId,id) ON DELETE RESTRICT,
  CHECK (laborCents + partsCents + unallocatedCents = amountCents),
  CHECK ((kind = 'OPENING' AND occurredAt IS NULL AND actorId IS NULL AND unallocatedCents = amountCents)
      OR (kind <> 'OPENING' AND occurredAt IS NOT NULL AND actorId IS NOT NULL)),
  CHECK ((kind = 'REFUND' AND relatedPaymentId IS NOT NULL AND relatedPaymentId <> id
           AND reason IS NOT NULL AND length(trim(reason)) > 0)
      OR (kind <> 'REFUND' AND relatedPaymentId IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX Payment_opening_idx ON Payment(orderId) WHERE kind = 'OPENING';
--> statement-breakpoint
CREATE INDEX Payment_occurredAt_idx ON Payment(occurredAt);
--> statement-breakpoint
CREATE INDEX Payment_related_idx ON Payment(orderId,relatedPaymentId) WHERE relatedPaymentId IS NOT NULL;
--> statement-breakpoint
INSERT INTO Payment(id,orderId,kind,amountCents,laborCents,partsCents,unallocatedCents)
SELECT 'opening:' || orderId, orderId, 'OPENING', paidCents, 0, 0, paidCents
FROM LegacyFinancialSnapshot WHERE paidCents > 0;
--> statement-breakpoint
-- Записывается в одной транзакции с выполненным действием.
CREATE TABLE WorkflowRequest (
  actorId TEXT NOT NULL REFERENCES User(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL, requestId TEXT NOT NULL, payloadHash TEXT NOT NULL,
  orderId TEXT NOT NULL REFERENCES WorkOrder(id) ON DELETE RESTRICT,
  resultId TEXT NOT NULL,
  PRIMARY KEY(actorId,operation,requestId)
) STRICT;
