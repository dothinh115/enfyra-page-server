import { Logger } from '@nestjs/common';
import { Knex } from 'knex';
import type { MetadataCacheService } from '../../cache/services/metadata-cache.service';
import { stringifyRecordJsonFields } from '../utils/json-parser';
import { parseBooleanFields } from '../../query-builder/utils/sql/parse-boolean-fields';

export type HookEvent = 'beforeInsert' | 'afterInsert' | 'beforeUpdate' | 'afterUpdate' | 'beforeDelete' | 'afterDelete' | 'beforeSelect' | 'afterSelect';

export interface HookRegistry {
  beforeInsert: Array<(tableName: string, data: any) => any>;
  afterInsert: Array<(tableName: string, result: any) => any>;
  beforeUpdate: Array<(tableName: string, data: any) => any>;
  afterUpdate: Array<(tableName: string, result: any) => any>;
  beforeDelete: Array<(tableName: string, criteria: any) => any>;
  afterDelete: Array<(tableName: string, result: any) => any>;
  beforeSelect: Array<(qb: any, tableName: string) => any>;
  afterSelect: Array<(tableName: string, result: any) => any>;
}

export class KnexHookRegistry {
  private hooks: HookRegistry = {
    beforeInsert: [],
    afterInsert: [],
    beforeUpdate: [],
    afterUpdate: [],
    beforeDelete: [],
    afterDelete: [],
    beforeSelect: [],
    afterSelect: [],
  };

  constructor(
    private knexInstance: Knex,
    private metadataCacheService: MetadataCacheService,
    private logger: Logger,
    private stripUnknownColumns: (tableName: string, data: any) => Promise<any>,
    private stripNonUpdatableFields: (tableName: string, data: any) => Promise<any>,
    private transformRelationsToFK: (tableName: string, data: any) => Promise<any>,
    private syncManyToManyRelations: (tableName: string, data: any) => Promise<void>,
    private handleCascadeRelations: (tableName: string, recordId: any, cascadeContextMap: Map<string, any>) => Promise<void>,
    private autoParseJsonFields: (result: any, options: any) => any,
    private isJunctionTable: (tableName: string) => Promise<boolean>,
  ) {}

  getHooks(): HookRegistry {
    return this.hooks;
  }

  addHook(event: HookEvent, handler: any): void {
    if (!this.hooks[event]) throw new Error(`Unknown hook event: ${event}`);
    this.hooks[event].push(handler);
  }

  removeHook(event: HookEvent, handler: any): void {
    const index = this.hooks[event].indexOf(handler);
    if (index > -1) this.hooks[event].splice(index, 1);
  }

  async runHooks(event: HookEvent, ...args: any[]): Promise<any> {
    let result = args[args.length - 1];
    for (const hook of this.hooks[event]) {
      result = await Promise.resolve(hook.apply(null, args));
      args[args.length - 1] = result;
    }
    return result;
  }

  registerDefaultHooks(cascadeContextMap: Map<string, any>): void {
    this.addHook('beforeInsert', async (tableName, data) => {
      const relationData: any = {};
      if (typeof data === 'object' && !Array.isArray(data)) {
        for (const key in data) {
          if (Array.isArray(data[key])) {
            relationData[key] = data[key];
          }
        }
      }
      cascadeContextMap.set(tableName, relationData);

      await this.syncManyToManyRelations(tableName, data);
      return this.transformRelationsToFK(tableName, data);
    });

    this.addHook('beforeInsert', (tableName, data) => {
      return this.stripUnknownColumns(tableName, data);
    });

    this.addHook('beforeInsert', async (tableName, data) => {
      const tableMetadata = await this.metadataCacheService.getTableMetadata(tableName);
      if (!tableMetadata) return data;
      return stringifyRecordJsonFields(data, tableMetadata);
    });

    this.addHook('beforeInsert', async (tableName, data) => {
      if (await this.isJunctionTable(tableName)) return data;

      const now = this.knexInstance.raw('CURRENT_TIMESTAMP');
      if (Array.isArray(data)) {
        return data.map(record => {
          const { createdAt, updatedAt, created_at, updated_at, CreatedAt, UpdatedAt, ...cleanRecord } = record;
          return { ...cleanRecord, createdAt: now, updatedAt: now };
        });
      }
      const { createdAt, updatedAt, created_at, updated_at, CreatedAt, UpdatedAt, ...cleanData } = data;
      return { ...cleanData, createdAt: now, updatedAt: now };
    });

    this.addHook('afterInsert', async (tableName, result) => {
      await this.handleCascadeRelations(tableName, result, cascadeContextMap);
      return result;
    });

    this.addHook('beforeUpdate', async (tableName, data) => {
      const originalRelationData: any = {};
      let recordId = data.id;

      if (typeof data === 'object' && !Array.isArray(data)) {
        for (const key in data) {
          if (Array.isArray(data[key])) {
            originalRelationData[key] = data[key];
          }
        }
      }

      cascadeContextMap.set(tableName, { relationData: originalRelationData, recordId });

      await this.syncManyToManyRelations(tableName, data);
      return this.transformRelationsToFK(tableName, data);
    });

    this.addHook('beforeUpdate', (tableName, data) => {
      return this.stripUnknownColumns(tableName, data);
    });

    this.addHook('beforeUpdate', async (tableName, data) => {
      const tableMetadata = await this.metadataCacheService.getTableMetadata(tableName);
      if (!tableMetadata) return data;
      return stringifyRecordJsonFields(data, tableMetadata);
    });

    this.addHook('beforeUpdate', (tableName, data) => {
      const { createdAt, updatedAt, created_at, updated_at, CreatedAt, UpdatedAt, ...updateData } = data;
      return this.stripNonUpdatableFields(tableName, updateData);
    });

    this.addHook('beforeUpdate', async (tableName, data) => {
      if (await this.isJunctionTable(tableName)) return data;
      return { ...data, updatedAt: this.knexInstance.raw('CURRENT_TIMESTAMP') };
    });

    this.addHook('afterUpdate', async (tableName: string, result: any) => {
      const context = cascadeContextMap.get(tableName);
      if (!context) {
        this.logger.log(`[afterUpdate] No cascade context found for table: ${tableName}`);
        return result;
      }

      const { recordId } = context;
      await this.handleCascadeRelations(tableName, recordId, cascadeContextMap);
      return result;
    });

    this.addHook('afterSelect', (tableName, result) => {
      return this.autoParseJsonFields(result, { table: tableName });
    });

    this.addHook('afterSelect', (tableName, result) => {
      return parseBooleanFields(result);
    });

    this.logger.log('🪝 Default hooks registered');
  }
}
