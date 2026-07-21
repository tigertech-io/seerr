import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ContentPolicyResult = 'allow' | 'deny' | 'review';

@Entity()
@Index(['mediaType', 'tmdbId'], { unique: true })
export default class ContentPolicyDecision {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'integer' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public result: ContentPolicyResult;

  @Column({ type: 'varchar' })
  public policyVersion: string;

  @Column({ type: 'varchar' })
  public policyHash: string;

  @Column({ type: 'varchar' })
  public metadataHash: string;

  @Column({ type: 'simple-json', default: '[]' })
  public matchedRuleIds: string[];

  @Column({ type: 'simple-json', default: '[]' })
  public categories: string[];

  @Column({ type: 'simple-json', default: '{}' })
  public evidence: Record<string, unknown>;

  @Column({ type: 'simple-json', default: '[]' })
  public sourceMemberships: string[];

  @Column({ type: 'varchar', default: 'unreviewed' })
  public reviewState: 'unreviewed' | 'acknowledged';

  @Column({ type: 'text', nullable: true })
  public reviewNote?: string | null;

  @Column({ type: 'integer', nullable: true })
  public reviewedById?: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public reviewedAt?: Date | null;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ContentPolicyDecision>) {
    Object.assign(this, init);
  }
}
