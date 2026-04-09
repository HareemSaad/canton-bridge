import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BridgeTxStatus {
  PENDING = 'PENDING',
  RELAYED = 'RELAYED',
  FAILED = 'FAILED',
}

@Entity('bridge_transactions')
export class BridgeTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'bigint' })
  nonce: string;

  @Column({ type: 'varchar', length: 42 })
  token: string;

  @Column({ type: 'numeric', precision: 78, scale: 0 })
  amount: string;

  @Column({ type: 'text' })
  recipient: string;

  @Column({ name: 'to_chain', type: 'varchar', length: 66 })
  toChain: string;

  @Column({ name: 'block_number', type: 'bigint' })
  blockNumber: string;

  @Column({ name: 'block_timestamp', type: 'bigint' })
  blockTimestamp: string;

  @Column({ name: 'transaction_hash', type: 'varchar', length: 66 })
  transactionHash: string;

  @Index()
  @Column({
    type: 'enum',
    enum: BridgeTxStatus,
    default: BridgeTxStatus.PENDING,
  })
  status: BridgeTxStatus;

  @Column({ name: 'canton_tx_id', type: 'text', nullable: true })
  cantonTxId: string | null;

  @Column({ name: 'canton_submitted_at', type: 'timestamptz', nullable: true })
  cantonSubmittedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
