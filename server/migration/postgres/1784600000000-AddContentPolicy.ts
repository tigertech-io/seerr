import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContentPolicy1784600000000 implements MigrationInterface {
  name = 'AddContentPolicy1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "content_policy_decision" ("id" SERIAL NOT NULL, "mediaType" character varying NOT NULL, "tmdbId" integer NOT NULL, "result" character varying NOT NULL, "policyVersion" character varying NOT NULL, "policyHash" character varying NOT NULL, "metadataHash" character varying NOT NULL, "matchedRuleIds" text NOT NULL DEFAULT '[]', "categories" text NOT NULL DEFAULT '[]', "evidence" text NOT NULL DEFAULT '{}', "sourceMemberships" text NOT NULL DEFAULT '[]', "reviewState" character varying NOT NULL DEFAULT 'unreviewed', "reviewNote" text, "reviewedById" integer, "reviewedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_content_policy_decision" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_content_policy_media" ON "content_policy_decision" ("mediaType", "tmdbId")`
    );
    await queryRunner.query(
      `CREATE TABLE "content_policy_event" ("id" SERIAL NOT NULL, "eventType" character varying NOT NULL, "mediaType" character varying, "tmdbId" integer, "actorUserId" integer, "decisionId" integer, "policyVersion" character varying, "policyHash" character varying, "details" text NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_content_policy_event" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_content_policy_event_type" ON "content_policy_event" ("eventType")`
    );
    await queryRunner.query(
      `CREATE TABLE "content_policy_override" ("id" SERIAL NOT NULL, "tokenHash" character varying NOT NULL, "administratorId" integer NOT NULL, "mediaType" character varying NOT NULL, "tmdbId" integer NOT NULL, "action" character varying NOT NULL, "reason" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP NOT NULL, "consumedAt" TIMESTAMP, "expiredNotificationAt" TIMESTAMP, CONSTRAINT "UQ_content_policy_override_token" UNIQUE ("tokenHash"), CONSTRAINT "PK_content_policy_override" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_content_policy_override_admin" ON "content_policy_override" ("administratorId")`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "policyDecisionId" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "policyOverrideId" integer`
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
