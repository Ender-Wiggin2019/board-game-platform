CREATE TABLE "mail_online_presence" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

--> statement-breakpoint
ALTER TABLE "mail_online_presence" ADD CONSTRAINT "mail_online_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mail_online_presence_user_expiry_idx" ON "mail_online_presence" USING btree ("user_id","expires_at");
