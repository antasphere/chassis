CREATE TABLE "connection_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_deliveries_outcome_check" CHECK ("connection_deliveries"."outcome" IN ('processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"secret_sealed" text,
	"secret_set_at" timestamp with time zone,
	"secret_set_by" text,
	"token_hash" text,
	"url_made_at" timestamp with time zone,
	"url_made_by" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by" text,
	"last_delivery_at" timestamp with time zone,
	"last_delivery_type" text,
	"last_delivery_outcome" text,
	"checked_at" timestamp with time zone,
	"check_ok" boolean,
	"check_detail" text DEFAULT '' NOT NULL,
	"sibling_endpoint_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_last_outcome_check" CHECK ("connections"."last_delivery_outcome" IS NULL OR "connections"."last_delivery_outcome" IN ('processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "connection_deliveries" ADD CONSTRAINT "connection_deliveries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_deliveries" ADD CONSTRAINT "connection_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_secret_set_by_user_id_fk" FOREIGN KEY ("secret_set_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_url_made_by_user_id_fk" FOREIGN KEY ("url_made_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_deliveries_dedupe_idx" ON "connection_deliveries" USING btree ("workspace_id","source","delivery_id");--> statement-breakpoint
CREATE INDEX "connection_deliveries_connection_received_id_idx" ON "connection_deliveries" USING btree ("connection_id","received_at","id");--> statement-breakpoint
CREATE INDEX "connection_deliveries_received_idx" ON "connection_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_workspace_source_idx" ON "connections" USING btree ("workspace_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_token_hash_idx" ON "connections" USING btree ("token_hash");