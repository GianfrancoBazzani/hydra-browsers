CREATE TABLE `vault_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`website` text NOT NULL,
	`username_enc` blob,
	`password_enc` blob,
	`totp_enc` blob,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vault_credentials_has_value" CHECK("vault_credentials"."username_enc" IS NOT NULL OR "vault_credentials"."password_enc" IS NOT NULL OR "vault_credentials"."totp_enc" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `vault_credentials_session_idx` ON `vault_credentials` (`session_id`);