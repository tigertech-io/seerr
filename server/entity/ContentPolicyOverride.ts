import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type ContentPolicyAction = 'create' | 'approve' | 'retry';

@Entity()
export default class ContentPolicyOverride {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', unique: true })
  @Index()
  public tokenHash: string;

  @Column({ type: 'integer' })
  @Index()
  public administratorId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'integer' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public action: ContentPolicyAction;

  @Column({ type: 'text' })
  public reason: string;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public expiresAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public consumedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public expiredNotificationAt?: Date | null;

  constructor(init?: Partial<ContentPolicyOverride>) {
    Object.assign(this, init);
  }
}
