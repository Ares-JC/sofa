CREATE TABLE `playbackProgress` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL,
	`titleId` text NOT NULL,
	`episodeId` text,
	`mediaKey` text NOT NULL,
	`positionSeconds` integer NOT NULL,
	`durationSeconds` integer NOT NULL,
	`source` text NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT `fk_playbackProgress_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_playbackProgress_titleId_titles_id_fk` FOREIGN KEY (`titleId`) REFERENCES `titles`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_playbackProgress_episodeId_episodes_id_fk` FOREIGN KEY (`episodeId`) REFERENCES `episodes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbackProgress_userId_mediaKey` ON `playbackProgress` (`userId`,`mediaKey`);--> statement-breakpoint
CREATE INDEX `playbackProgress_userId_updatedAt` ON `playbackProgress` (`userId`,`updatedAt`);