import { Entity, Index, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Test1 } from './test1.entity';

@Entity('test2')
@Index(['ok'])
export class Test2 {
    @PrimaryGeneratedColumn('increment')
    id: number;
    @ManyToOne('Test1', { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
    @JoinColumn()
    ok: any;
    @CreateDateColumn()
    createdAt: Date;
    @UpdateDateColumn()
    updatedAt: Date;
}
