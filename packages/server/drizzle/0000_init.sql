CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`token_hmac` blob NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`last_used_ip` text,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tokens_token_hmac_unique` ON `agent_tokens` (`token_hmac`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`session_id` text,
	`status` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_session_ts_idx` ON `audit_events` (`session_id`,`ts`);--> statement-breakpoint
CREATE INDEX `audit_events_kind_ts_idx` ON `audit_events` (`kind`,`ts`);--> statement-breakpoint
CREATE TABLE `live_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`login_session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`neko_profile` text NOT NULL,
	`cookie_hmac` blob NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`login_session_id`) REFERENCES `login_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_grants_cookie_hmac_unique` ON `live_grants` (`cookie_hmac`);--> statement-breakpoint
CREATE TABLE `login_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hmac` blob NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_sessions_token_hmac_unique` ON `login_sessions` (`token_hmac`);--> statement-breakpoint
CREATE TABLE `session_members` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`desired_state` text NOT NULL,
	`state` text NOT NULL,
	`error_reason` text,
	`media_port` integer,
	`allowlist` text NOT NULL,
	`timezone` text NOT NULL,
	`language` text NOT NULL,
	`screen` text NOT NULL,
	`applied_settings` text NOT NULL,
	`started_at` integer,
	`ready_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_media_port_unique` ON `sessions` (`media_port`) WHERE "sessions"."media_port" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`must_change_password` integer NOT NULL,
	`failed_logins` integer DEFAULT 0 NOT NULL,
	`locked_at` integer,
	`last_login_at` integer,
	`password_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);