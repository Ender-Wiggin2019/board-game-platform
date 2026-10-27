CREATE TABLE "account_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid,
	"event_kind" text NOT NULL,
	"request_id" text,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);

--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"draft_id" uuid,
	"user_id" uuid,
	"email" text,
	"email_key" text NOT NULL,
	"secret_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"email_version" integer,
	"session_version" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"csrf_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"replacement_id" uuid,
	"user_agent" text,
	"ip_address" text,
	CONSTRAINT "auth_sessions_refresh_hash_uq" UNIQUE("refresh_hash")
);

--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_one_id" uuid NOT NULL,
	"user_two_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendships_pair_unique" UNIQUE("user_one_id","user_two_id"),
	CONSTRAINT "friendships_distinct_users_check" CHECK ("friendships"."user_one_id" <> "friendships"."user_two_id")
);

--> statement-breakpoint
CREATE TABLE "game_foreground_presence" (
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_foreground_presence_pkey" PRIMARY KEY("user_id","game_id")
);

--> statement-breakpoint
CREATE TABLE "global_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" jsonb NOT NULL,
	"requires_resolution" boolean DEFAULT false NOT NULL,
	"severity" text NOT NULL,
	"created_by_user_id" uuid,
	"recipient_user_id" uuid,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_messages_resolution_recipient_check" CHECK (NOT "global_messages"."requires_resolution" OR "global_messages"."recipient_user_id" IS NOT NULL)
);

--> statement-breakpoint
CREATE TABLE "invite_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"redeemed_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_redemptions_code_user_unique" UNIQUE("invite_code_id","user_id"),
	CONSTRAINT "invite_code_redemptions_role_check" CHECK ("invite_code_redemptions"."redeemed_role" IN ('player', 'navigator', 'tester'))
);

--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"disabled_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "invite_codes_max_uses_positive_check" CHECK ("invite_codes"."max_uses" IS NULL OR "invite_codes"."max_uses" > 0),
	CONSTRAINT "invite_codes_role_check" CHECK ("invite_codes"."role" IN ('player', 'navigator', 'tester'))
);

--> statement-breakpoint
CREATE TABLE "mail_budget_buckets" (
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"limit_units" integer NOT NULL,
	"used_units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_budget_buckets_pkey" PRIMARY KEY("scope","scope_key","window_start"),
	CONSTRAINT "mail_budget_limit_check" CHECK ("mail_budget_buckets"."limit_units" >= 0),
	CONSTRAINT "mail_budget_used_check" CHECK ("mail_budget_buckets"."used_units" >= 0)
);

--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"user_id" uuid,
	"email_version" integer,
	"challenge_id" uuid,
	"game_id" uuid,
	"runtime_owner" text DEFAULT 'legacy' NOT NULL,
	"session_id" text,
	"attention_epoch" integer,
	"recipient" text NOT NULL,
	"kind" text NOT NULL,
	"template_key" text NOT NULL,
	"template_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitive_payload_ciphertext" text,
	"sensitive_payload_nonce" text,
	"sensitive_payload_tag" text,
	"sensitive_payload_key_version" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text DEFAULT 'unknown' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"not_before" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"provider_message_id" text,
	"provider_request_id" text,
	"provider_sent_at" timestamp with time zone,
	"unknown_since" timestamp with time zone,
	"last_status_checked_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_outbox_attempt_count_check" CHECK ("mail_outbox"."attempt_count" >= 0),
	CONSTRAINT "mail_outbox_delivery_status_check" CHECK ("mail_outbox"."delivery_status" IN ('unknown', 'delivered', 'bounced', 'complained')),
	CONSTRAINT "mail_outbox_kind_check" CHECK ("mail_outbox"."kind" IN ('account_verification', 'password_recovery', 'email_change_verification', 'security_notice', 'migration_completed', 'turn_reminder')),
	CONSTRAINT "mail_outbox_max_attempts_check" CHECK ("mail_outbox"."max_attempts" > 0),
	CONSTRAINT "mail_outbox_sensitive_payload_check" CHECK (("mail_outbox"."sensitive_payload_ciphertext" IS NULL AND "mail_outbox"."sensitive_payload_nonce" IS NULL AND "mail_outbox"."sensitive_payload_tag" IS NULL AND "mail_outbox"."sensitive_payload_key_version" IS NULL) OR ("mail_outbox"."sensitive_payload_ciphertext" IS NOT NULL AND "mail_outbox"."sensitive_payload_nonce" IS NOT NULL AND "mail_outbox"."sensitive_payload_tag" IS NOT NULL AND "mail_outbox"."sensitive_payload_key_version" IS NOT NULL)),
	CONSTRAINT "mail_outbox_status_check" CHECK ("mail_outbox"."status" IN ('pending', 'processing', 'retry_wait', 'accepted', 'unknown', 'cancelled', 'dead')),
	CONSTRAINT "mail_outbox_target_check" CHECK ((
          "mail_outbox"."runtime_owner" = 'legacy' AND "mail_outbox"."session_id" IS NULL
        ) OR (
          "mail_outbox"."runtime_owner" = 'platform' AND "mail_outbox"."session_id" IS NOT NULL AND "mail_outbox"."game_id" IS NULL
        ))
);

--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient" text NOT NULL,
	"category" text DEFAULT 'all' NOT NULL,
	"reason" text NOT NULL,
	"source" text DEFAULT 'application' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "mail_turn_mutes" (
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"muted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_turn_mutes_pkey" PRIMARY KEY("user_id","game_id")
);

--> statement-breakpoint
CREATE TABLE "notification_cursors" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attention_epoch" integer DEFAULT 0 NOT NULL,
	"actionable" boolean DEFAULT false NOT NULL,
	"action_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_cursors_pkey" PRIMARY KEY("game_id","user_id"),
	CONSTRAINT "notification_cursors_epoch_check" CHECK ("notification_cursors"."attention_epoch" >= 0)
);

--> statement-breakpoint
CREATE TABLE "platform_foreground_presence" (
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_foreground_presence_pkey" PRIMARY KEY("user_id","session_id")
);

--> statement-breakpoint
CREATE TABLE "platform_mail_turn_mutes" (
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"muted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_mail_turn_mutes_pkey" PRIMARY KEY("user_id","session_id")
);

--> statement-breakpoint
CREATE TABLE "platform_notification_cursors" (
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"attention_epoch" integer DEFAULT 0 NOT NULL,
	"actionable" boolean DEFAULT false NOT NULL,
	"action_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_notification_cursors_pkey" PRIMARY KEY("session_id","user_id"),
	CONSTRAINT "platform_notification_cursors_epoch_check" CHECK ("platform_notification_cursors"."attention_epoch" >= 0)
);

--> statement-breakpoint
CREATE TABLE "platform_notification_deliveries" (
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_notification_deliveries_pkey" PRIMARY KEY("session_id","user_id","notification_key")
);

--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);

--> statement-breakpoint
CREATE TABLE "registration_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'normal' NOT NULL,
	"secret_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"status" text DEFAULT 'email_pending' NOT NULL,
	"email" text,
	"email_key" text,
	"verified_email_key" text,
	"email_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"request_fingerprint" text,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_drafts_secret_hash_uq" UNIQUE("secret_hash")
);

--> statement-breakpoint
CREATE TABLE "user_message_reads" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_message_reads_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);

--> statement-breakpoint
CREATE TABLE "user_message_resolutions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "user_message_resolutions_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);

--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_key" text GENERATED ALWAYS AS (lower(name)) STORED,
	"email" text NOT NULL,
	"email_key" text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"email_version" integer DEFAULT 1 NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"permission_version" integer DEFAULT 0 NOT NULL,
	"role" text DEFAULT 'guest' NOT NULL,
	"navigator_granted_at" timestamp with time zone,
	"navigator_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_account_status_check" CHECK ("users"."account_status" IN ('active', 'suspended', 'deleted')),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('guest', 'player', 'tester', 'admin', 'superadmin'))
);

--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_draft_id_registration_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."registration_drafts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_one_id_users_id_fk" FOREIGN KEY ("user_one_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_two_id_users_id_fk" FOREIGN KEY ("user_two_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "game_foreground_presence" ADD CONSTRAINT "game_foreground_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "global_messages" ADD CONSTRAINT "global_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "global_messages" ADD CONSTRAINT "global_messages_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_turn_mutes" ADD CONSTRAINT "mail_turn_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_cursors" ADD CONSTRAINT "notification_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_foreground_presence" ADD CONSTRAINT "platform_foreground_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_mail_turn_mutes" ADD CONSTRAINT "platform_mail_turn_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_notification_cursors" ADD CONSTRAINT "platform_notification_cursors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_notification_deliveries" ADD CONSTRAINT "platform_notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_message_reads" ADD CONSTRAINT "user_message_reads_message_id_global_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."global_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_message_reads" ADD CONSTRAINT "user_message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_message_resolutions" ADD CONSTRAINT "user_message_resolutions_message_id_global_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."global_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_message_resolutions" ADD CONSTRAINT "user_message_resolutions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "account_security_events_subject_idx" ON "account_security_events" USING btree ("subject_user_id","created_at");
--> statement-breakpoint
CREATE INDEX "account_security_events_request_idx" ON "account_security_events" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "auth_challenges_draft_idx" ON "auth_challenges" USING btree ("draft_id");
--> statement-breakpoint
CREATE INDEX "auth_challenges_user_idx" ON "auth_challenges" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "auth_challenges_expiry_idx" ON "auth_challenges" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "auth_sessions_family_idx" ON "auth_sessions" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX "auth_sessions_expiry_idx" ON "auth_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "friendships_user_one_idx" ON "friendships" USING btree ("user_one_id");
--> statement-breakpoint
CREATE INDEX "friendships_user_two_idx" ON "friendships" USING btree ("user_two_id");
--> statement-breakpoint
CREATE INDEX "friendships_requested_by_idx" ON "friendships" USING btree ("requested_by_user_id");
--> statement-breakpoint
CREATE INDEX "game_foreground_presence_expiry_idx" ON "game_foreground_presence" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "global_messages_created_at_idx" ON "global_messages" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "global_messages_recipient_created_at_idx" ON "global_messages" USING btree ("recipient_user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
CREATE UNIQUE INDEX "global_messages_source_key_unique" ON "global_messages" USING btree ("source_key") WHERE "global_messages"."source_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "invite_code_redemptions_user_idx" ON "invite_code_redemptions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "invite_codes_code_idx" ON "invite_codes" USING btree ("code");
--> statement-breakpoint
CREATE INDEX "invite_codes_created_at_idx" ON "invite_codes" USING btree ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_outbox_dedupe_key_idx" ON "mail_outbox" USING btree ("dedupe_key");
--> statement-breakpoint
CREATE INDEX "mail_outbox_claim_idx" ON "mail_outbox" USING btree ("status","next_attempt_at","priority") WHERE "mail_outbox"."status" NOT IN ('cancelled', 'dead');
--> statement-breakpoint
CREATE INDEX "mail_outbox_reconcile_idx" ON "mail_outbox" USING btree ("status","delivery_status","last_status_checked_at");
--> statement-breakpoint
CREATE INDEX "mail_outbox_platform_target_idx" ON "mail_outbox" USING btree ("runtime_owner","session_id","user_id","attention_epoch");
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_suppressions_recipient_category_idx" ON "mail_suppressions" USING btree (lower("recipient"),"category");
--> statement-breakpoint
CREATE INDEX "notification_cursors_game_action_idx" ON "notification_cursors" USING btree ("game_id","actionable","updated_at");
--> statement-breakpoint
CREATE INDEX "platform_foreground_presence_expiry_idx" ON "platform_foreground_presence" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "platform_notification_cursors_action_idx" ON "platform_notification_cursors" USING btree ("session_id","actionable","updated_at");
--> statement-breakpoint
CREATE INDEX "platform_notification_deliveries_created_idx" ON "platform_notification_deliveries" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "registration_drafts_status_idx" ON "registration_drafts" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "registration_drafts_expiry_idx" ON "registration_drafts" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "user_message_reads_user_idx" ON "user_message_reads" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "user_message_reads_read_at_idx" ON "user_message_reads" USING btree ("read_at","message_id","user_id");
--> statement-breakpoint
CREATE INDEX "user_message_resolutions_pending_user_idx" ON "user_message_resolutions" USING btree ("user_id","message_id") WHERE "user_message_resolutions"."resolved_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_name_key_uq" ON "users" USING btree ("name_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key_uq" ON "users" USING btree ("email_key");
