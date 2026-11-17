CREATE TABLE `User` (
 `id` TEXT PRIMARY KEY NOT NULL, `providerId` TEXT UNIQUE, `name` TEXT NOT NULL,
 `email` TEXT NOT NULL COLLATE NOCASE UNIQUE, `role` TEXT NOT NULL DEFAULT 'MASTER' CHECK (`role` IN ('ADMIN','RECEPTION','MASTER')),
 `active` INTEGER NOT NULL DEFAULT 1 CHECK (`active` IN (0,1)),
 `createdAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE `Customer` (
 `id` TEXT PRIMARY KEY NOT NULL, `kind` TEXT NOT NULL DEFAULT 'PERSON' CHECK (`kind` IN ('PERSON','COMPANY')),
 `name` TEXT NOT NULL, `phone` TEXT NOT NULL, `phoneNormalized` TEXT NOT NULL, `email` TEXT,
 `comment` TEXT NOT NULL DEFAULT '', `archivedAt` TEXT,
 `createdAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 `updatedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX `Customer_phoneNormalized_idx` ON `Customer` (`phoneNormalized`);
--> statement-breakpoint
CREATE INDEX `Customer_name_idx` ON `Customer` (`name`);
--> statement-breakpoint
CREATE TABLE `Vehicle` (
 `id` TEXT PRIMARY KEY NOT NULL, `customerId` TEXT NOT NULL REFERENCES `Customer` (`id`) ON DELETE RESTRICT,
 `make` TEXT NOT NULL, `model` TEXT NOT NULL, `year` INTEGER CHECK (`year` BETWEEN 1886 AND 2200),
 `vin` TEXT UNIQUE, `plate` TEXT, `mileage` INTEGER NOT NULL DEFAULT 0 CHECK (`mileage` BETWEEN 0 AND 10000000),
 `engine` TEXT NOT NULL DEFAULT '', `comment` TEXT NOT NULL DEFAULT '', `archivedAt` TEXT,
 `createdAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 `updatedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX `Vehicle_customerId_idx` ON `Vehicle` (`customerId`);
--> statement-breakpoint
CREATE INDEX `Vehicle_plate_idx` ON `Vehicle` (`plate`);
--> statement-breakpoint
CREATE TABLE `VehicleOwnership` (
 `id` TEXT PRIMARY KEY NOT NULL, `vehicleId` TEXT NOT NULL REFERENCES `Vehicle` (`id`) ON DELETE RESTRICT,
 `customerId` TEXT NOT NULL REFERENCES `Customer` (`id`) ON DELETE RESTRICT,
 `startedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), `endedAt` TEXT
);
--> statement-breakpoint
CREATE INDEX `VehicleOwnership_vehicleId_startedAt_idx` ON `VehicleOwnership` (`vehicleId`,`startedAt`);
--> statement-breakpoint
CREATE TABLE `WorkOrder` (
 `id` TEXT PRIMARY KEY NOT NULL, `number` TEXT NOT NULL UNIQUE,
 `customerId` TEXT NOT NULL REFERENCES `Customer` (`id`) ON DELETE RESTRICT,
 `vehicleId` TEXT NOT NULL REFERENCES `Vehicle` (`id`) ON DELETE RESTRICT,
 `masterId` TEXT REFERENCES `User` (`id`) ON DELETE RESTRICT,
 `status` TEXT NOT NULL DEFAULT 'NEW' CHECK (`status` IN ('NEW','DIAGNOSTICS','APPROVAL','IN_PROGRESS','READY','DELIVERED','CANCELLED')),
 `mileage` INTEGER NOT NULL CHECK (`mileage` BETWEEN 0 AND 10000000), `complaint` TEXT NOT NULL,
 `recommendations` TEXT NOT NULL DEFAULT '', `comment` TEXT NOT NULL DEFAULT '',
 `discountCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`discountCents`)='integer' AND `discountCents` BETWEEN 0 AND 9007199254740991),
 `paidCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`paidCents`)='integer' AND `paidCents` BETWEEN 0 AND 9007199254740991),
 `version` INTEGER NOT NULL DEFAULT 0 CHECK (`version` >= 0),
 `openedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), `closedAt` TEXT,
 `updatedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX `WorkOrder_vehicleId_openedAt_idx` ON `WorkOrder` (`vehicleId`,`openedAt`);
--> statement-breakpoint
CREATE INDEX `WorkOrder_customerId_idx` ON `WorkOrder` (`customerId`);
--> statement-breakpoint
CREATE INDEX `WorkOrder_status_openedAt_idx` ON `WorkOrder` (`status`,`openedAt`);
--> statement-breakpoint
CREATE INDEX `WorkOrder_masterId_status_idx` ON `WorkOrder` (`masterId`,`status`);
--> statement-breakpoint
CREATE TABLE `CatalogItem` (
 `id` TEXT PRIMARY KEY NOT NULL, `category` TEXT NOT NULL, `name` TEXT NOT NULL, `unit` TEXT NOT NULL DEFAULT 'шт.',
 `laborPriceCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`laborPriceCents`)='integer' AND `laborPriceCents` BETWEEN 0 AND 9007199254740991),
 `active` INTEGER NOT NULL DEFAULT 1 CHECK (`active` IN (0,1)), `sortOrder` INTEGER NOT NULL DEFAULT 0,
 UNIQUE (`category`,`name`)
);
--> statement-breakpoint
CREATE TABLE `InspectionItem` (
 `id` TEXT PRIMARY KEY NOT NULL, `orderId` TEXT NOT NULL REFERENCES `WorkOrder` (`id`) ON DELETE RESTRICT,
 `catalogItemId` TEXT REFERENCES `CatalogItem` (`id`) ON DELETE RESTRICT, `category` TEXT NOT NULL, `name` TEXT NOT NULL,
 `left` INTEGER NOT NULL DEFAULT 0 CHECK (`left` IN (0,1)), `right` INTEGER NOT NULL DEFAULT 0 CHECK (`right` IN (0,1)),
 `condition` TEXT NOT NULL DEFAULT 'UNCHECKED' CHECK (`condition` IN ('UNCHECKED','CHECKED','REPAIR','RECOMMENDED','DONE')),
 `quantityMilli` INTEGER NOT NULL DEFAULT 1000 CHECK (typeof(`quantityMilli`)='integer' AND `quantityMilli` BETWEEN 1 AND 1000000000),
 `laborPriceCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`laborPriceCents`)='integer' AND `laborPriceCents` BETWEEN 0 AND 9007199254740991),
 `originalPriceCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`originalPriceCents`)='integer' AND `originalPriceCents` BETWEEN 0 AND 9007199254740991),
 `analogPriceCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`analogPriceCents`)='integer' AND `analogPriceCents` BETWEEN 0 AND 9007199254740991),
 `customPriceCents` INTEGER NOT NULL DEFAULT 0 CHECK (typeof(`customPriceCents`)='integer' AND `customPriceCents` BETWEEN 0 AND 9007199254740991),
 `selectedPart` TEXT NOT NULL DEFAULT 'NONE' CHECK (`selectedPart` IN ('NONE','ORIGINAL','ANALOG','CUSTOM')),
 `note` TEXT NOT NULL DEFAULT '', `authorId` TEXT NOT NULL REFERENCES `User` (`id`) ON DELETE RESTRICT,
 `updatedAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE (`orderId`,`catalogItemId`), UNIQUE (`orderId`,`id`)
);
--> statement-breakpoint
CREATE INDEX `InspectionItem_orderId_idx` ON `InspectionItem` (`orderId`);
--> statement-breakpoint
CREATE TABLE `OrderLine` (
 `id` TEXT PRIMARY KEY NOT NULL, `orderId` TEXT NOT NULL REFERENCES `WorkOrder` (`id`) ON DELETE RESTRICT,
 `inspectionItemId` TEXT, `kind` TEXT NOT NULL CHECK (`kind` IN ('LABOR','PART')), `name` TEXT NOT NULL,
 `quantityMilli` INTEGER NOT NULL DEFAULT 1000 CHECK (typeof(`quantityMilli`)='integer' AND `quantityMilli` BETWEEN 1 AND 1000000000),
 `unitPriceCents` INTEGER NOT NULL CHECK (typeof(`unitPriceCents`)='integer' AND `unitPriceCents` BETWEEN 0 AND 9007199254740991),
 `variant` TEXT NOT NULL DEFAULT 'NONE' CHECK (`variant` IN ('NONE','ORIGINAL','ANALOG','CUSTOM')), `article` TEXT NOT NULL DEFAULT '',
 FOREIGN KEY (`orderId`,`inspectionItemId`) REFERENCES `InspectionItem` (`orderId`,`id`) ON DELETE RESTRICT,
 UNIQUE (`orderId`,`inspectionItemId`,`kind`)
);
--> statement-breakpoint
CREATE INDEX `OrderLine_orderId_idx` ON `OrderLine` (`orderId`);
--> statement-breakpoint
CREATE TABLE `Document` (
 `id` TEXT PRIMARY KEY NOT NULL, `orderId` TEXT NOT NULL REFERENCES `WorkOrder` (`id`) ON DELETE RESTRICT,
 `number` TEXT NOT NULL UNIQUE, `kind` TEXT NOT NULL CHECK (`kind` IN ('INSPECTION','WORK_ORDER')),
 `version` INTEGER NOT NULL CHECK (`version` >= 1), `templateVersion` TEXT NOT NULL DEFAULT '1.0',
 `snapshot` TEXT NOT NULL CHECK (json_valid(`snapshot`)), `pdf` BLOB NOT NULL, `sha256` TEXT NOT NULL,
 `authorId` TEXT NOT NULL REFERENCES `User` (`id`) ON DELETE RESTRICT,
 `createdAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE (`orderId`,`kind`,`version`)
);
--> statement-breakpoint
CREATE TABLE `ServiceSettings` (
 `id` TEXT PRIMARY KEY NOT NULL DEFAULT 'main', `name` TEXT NOT NULL DEFAULT 'Автосервис',
 `address` TEXT NOT NULL DEFAULT '', `phone` TEXT NOT NULL DEFAULT '', `taxId` TEXT NOT NULL DEFAULT '',
 `timezone` TEXT NOT NULL DEFAULT 'Europe/Kaliningrad'
);
--> statement-breakpoint
CREATE TABLE `Sequence` (`id` TEXT PRIMARY KEY NOT NULL, `value` INTEGER NOT NULL DEFAULT 0 CHECK (`value` >= 0));
--> statement-breakpoint
CREATE TABLE `AuditEvent` (
 `id` TEXT PRIMARY KEY NOT NULL, `actorId` TEXT NOT NULL REFERENCES `User` (`id`) ON DELETE RESTRICT,
 `action` TEXT NOT NULL, `entityType` TEXT NOT NULL, `entityId` TEXT NOT NULL,
 `data` TEXT NOT NULL CHECK (json_valid(`data`)),
 `createdAt` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX `AuditEvent_entityType_entityId_createdAt_idx` ON `AuditEvent` (`entityType`,`entityId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `AppMeta` (`key` TEXT PRIMARY KEY NOT NULL, `value` TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE `MutationGuard` (`key` TEXT PRIMARY KEY NOT NULL, `ok` INTEGER NOT NULL CONSTRAINT mutation_guard CHECK (`ok` = 1));
