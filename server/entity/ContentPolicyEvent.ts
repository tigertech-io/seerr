import type { MediaType } from '@server/constants/media';
import { resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export default class ContentPolicyEvent {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar' })
  @Index()
  public eventType: string;

  @Column({ type: 'varchar', nullable: true })
  public mediaType?: MediaType | null;

  @Column({ type: 'integer', nullable: true })
  public tmdbId?: number | null;

  @Column({ type: 'integer', nullable: true })
  public actorUserId?: number | null;

  @Column({ type: 'integer', nullable: true })
  public decisionId?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public policyVersion?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public policyHash?: string | null;

  @Column({ type: 'simple-json', default: '{}' })
  public details: Record<string, unknown>;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;

  constructor(init?: Partial<ContentPolicyEvent>) {
    Object.assign(this, init);
  }
}
