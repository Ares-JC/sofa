ALTER TABLE `integrations` ADD `allowedAccounts` text;--> statement-breakpoint
ALTER TABLE `integrationEvents` ADD `accountId` text;--> statement-breakpoint
ALTER TABLE `integrationEvents` ADD `accountName` text;