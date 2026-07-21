import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContentPolicy1784600000000 implements MigrationInterface {
  name = 'AddContentPolicy1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "content_policy_decision" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "result" varchar NOT NULL, "policyVersion" varchar NOT NULL, "policyHash" varchar NOT NULL, "metadataHash" varchar NOT NULL, "matchedRuleIds" text NOT NULL DEFAULT ('[]'), "categories" text NOT NULL DEFAULT ('[]'), "evidence" text NOT NULL DEFAULT ('{}'), "sourceMemberships" text NOT NULL DEFAULT ('[]'), "reviewState" varchar NOT NULL DEFAULT ('unreviewed'), "reviewNote" text, "reviewedById" integer, "reviewedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_content_policy_media" ON "content_policy_decision" ("mediaType", "tmdbId")`
    );
    await queryRunner.query(
      `CREATE TABLE "content_policy_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "eventType" varchar NOT NULL, "mediaType" varchar, "tmdbId" integer, "actorUserId" integer, "decisionId" integer, "policyVersion" varchar, "policyHash" varchar, "details" text NOT NULL DEFAULT ('{}'), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_content_policy_event_type" ON "content_policy_event" ("eventType")`
    );
    await queryRunner.query(
      `CREATE TABLE "content_policy_override" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tokenHash" varchar NOT NULL, "administratorId" integer NOT NULL, "mediaType" varchar NOT NULL, "tmdbId" integer NOT NULL, "action" varchar NOT NULL, "reason" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "expiresAt" datetime NOT NULL, "consumedAt" datetime, "expiredNotificationAt" datetime, CONSTRAINT "UQ_content_policy_override_token" UNIQUE ("tokenHash"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_content_policy_override_admin" ON "content_policy_override" ("administratorId")`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "policyDecisionId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD COLUMN "policyOverrideId" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "policyOverrideId"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "policyDecisionId"`
    );
    await queryRunner.query(`DROP INDEX "IDX_content_policy_override_admin"`);
    await queryRunner.query(`DROP TABLE "content_policy_override"`);
    await queryRunner.query(`DROP INDEX "IDX_content_policy_event_type"`);
    await queryRunner.query(`DROP TABLE "content_policy_event"`);
    await queryRunner.query(`DROP INDEX "IDX_content_policy_media"`);
    await queryRunner.query(`DROP TABLE "content_policy_decision"`);
  }
}
