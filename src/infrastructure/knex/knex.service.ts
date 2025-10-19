import { Injectable, Logger, OnModuleInit, OnModuleDestroy, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex, knex } from 'knex';
import { RelationHandlerService } from './services/relation-handler.service';
import { MetadataCacheService } from '../cache/services/metadata-cache.service';
import { applyRelations } from './utils/knex-helpers/query-with-relations';
import { ExtendedKnex } from './types/knex-extended.types';
import { parseBooleanFields } from '../query-builder/utils/parse-boolean-fields';

@Injectable()
export class KnexService implements OnModuleInit, OnModuleDestroy {
  private knexInstance: Knex;
  private readonly logger = new Logger(KnexService.name);
  private columnTypesMap: Map<string, Map<string, string>> = new Map();
  private dbType: string;

  // Hook registry
  private hooks: {
    beforeInsert: Array<(tableName: string, data: any) => any>;
    afterInsert: Array<(tableName: string, result: any) => any>;
    beforeUpdate: Array<(tableName: string, data: any) => any>;
    afterUpdate: Array<(tableName: string, result: any) => any>;
    beforeDelete: Array<(tableName: string, criteria: any) => any>;
    afterDelete: Array<(tableName: string, result: any) => any>;
    beforeSelect: Array<(qb: any, tableName: string) => any>;
    afterSelect: Array<(tableName: string, result: any) => any>;
  } = {
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
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => RelationHandlerService))
    private readonly relationHandler: RelationHandlerService,
    @Inject(forwardRef(() => MetadataCacheService))
    private readonly metadataCacheService: MetadataCacheService,
  ) {}

  async onModuleInit() {
    const DB_TYPE = this.configService.get<string>('DB_TYPE') || 'mysql';
    this.dbType = DB_TYPE;

    // Skip Knex initialization if using MongoDB
    if (DB_TYPE === 'mongodb') {
      this.logger.log('⏭️  Skipping Knex initialization (DB_TYPE=mongodb)');
      return;
    }

    
    this.logger.log('🔌 Initializing Knex connection with hooks...');
    
    const DB_HOST = this.configService.get<string>('DB_HOST') || 'localhost';
    const DB_PORT = this.configService.get<number>('DB_PORT') || (DB_TYPE === 'postgres' ? 5432 : 3306);
    const DB_USERNAME = this.configService.get<string>('DB_USERNAME') || 'root';
    const DB_PASSWORD = this.configService.get<string>('DB_PASSWORD') || '';
    const DB_NAME = this.configService.get<string>('DB_NAME') || 'enfyra';

    this.knexInstance = knex({
      client: DB_TYPE === 'postgres' ? 'pg' : 'mysql2',
      connection: {
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USERNAME,
        password: DB_PASSWORD,
        database: DB_NAME,
      },
      pool: {
        min: 2,
        max: 10,
      },
      acquireConnectionTimeout: 10000,
      debug: false,
    });

    // Register default hooks (replaces postProcessResponse)
    this.registerDefaultHooks();

    // Test connection
    try {
      await this.knexInstance.raw('SELECT 1');
      this.logger.log('✅ Knex connection established with timestamp hooks');
    } catch (error) {
      this.logger.error('❌ Failed to establish Knex connection:', error);
      throw error;
    }
  }

  private registerDefaultHooks() {
    this.addHook('beforeInsert', (tableName, data) => {
      if (Array.isArray(data)) {
        return data.map(record => this.transformRelationsToFK(tableName, record));
      }
      return this.transformRelationsToFK(tableName, data);
    });

    this.addHook('beforeInsert', (tableName, data) => {
      if (Array.isArray(data)) {
        return data.map(record => this.stripUnknownColumns(tableName, record));
      }
      return this.stripUnknownColumns(tableName, data);
    });

    this.addHook('beforeInsert', (tableName, data) => {
      if (Array.isArray(data)) {
        return data.map(record => this.convertDateFields(tableName, record));
      }
      return this.convertDateFields(tableName, data);
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

    this.addHook('beforeUpdate', async (tableName, data) => {
      await this.syncManyToManyRelations(tableName, data);
      return this.transformRelationsToFK(tableName, data);
    });

    this.addHook('beforeUpdate', (tableName, data) => {
      return this.stripUnknownColumns(tableName, data);
    });

    this.addHook('beforeUpdate', (tableName, data) => {
      return this.convertDateFields(tableName, data);
    });

    this.addHook('beforeUpdate', (tableName, data) => {
      const { createdAt, updatedAt, created_at, updated_at, CreatedAt, UpdatedAt, ...updateData } = data;
      return this.stripNonUpdatableFields(tableName, updateData);
    });

    this.addHook('beforeUpdate', async (tableName, data) => {
      if (await this.isJunctionTable(tableName)) return data;
      return { ...data, updatedAt: this.knexInstance.raw('CURRENT_TIMESTAMP') };
    });

    this.addHook('afterSelect', (tableName, result) => {
      return this.autoParseJsonFields(result, { table: tableName });
    });

    this.addHook('afterSelect', (tableName, result) => {
      return parseBooleanFields(result);
    });

    this.logger.log('🪝 Default hooks registered');
  }

  private async isJunctionTable(tableName: string): Promise<boolean> {
    // Query metadata to check if this table is a junction table
    const metadata = await this.metadataCacheService.getMetadata();
    if (!metadata) return false;

    const tables = Array.from(metadata.tables?.values?.() || []) || metadata.tablesList || [];
    for (const table of tables) {
      if (!table.relations) continue;
      for (const rel of table.relations) {
        if (rel.type === 'many-to-many' && rel.junctionTableName === tableName) {
          return true;
        }
      }
    }
    return false;
  }

  addHook(event: keyof typeof this.hooks, handler: any): void {
    if (!this.hooks[event]) throw new Error(`Unknown hook event: ${event}`);
    this.hooks[event].push(handler);
  }

  removeHook(event: keyof typeof this.hooks, handler: any): void {
    const index = this.hooks[event].indexOf(handler);
    if (index > -1) this.hooks[event].splice(index, 1);
  }

  private async runHooks(event: keyof typeof this.hooks, ...args: any[]): Promise<any> {
    let result = args[args.length - 1];
    for (const hook of this.hooks[event]) {
      result = await Promise.resolve(hook.apply(null, args));
      args[args.length - 1] = result;
    }
    return result;
  }

  private wrapQueryBuilder(qb: any, knexInstance: Knex): any {
    const self = this;
    const originalInsert = qb.insert;
    const originalUpdate = qb.update;
    const originalDelete = qb.delete || qb.del;
    const originalSelect = qb.select;
    const originalThen = qb.then;
    const tableName = qb._single?.table;

    qb._relationMetadata = null;
    qb._joinedRelations = new Set();

    qb.insert = async function(data: any, ...rest: any[]) {
      const processedData = await self.runHooks('beforeInsert', tableName, data);
      const result = await originalInsert.call(this, processedData, ...rest);
      return self.runHooks('afterInsert', tableName, result);
    };

    qb.update = async function(data: any, ...rest: any[]) {
      const processedData = await self.runHooks('beforeUpdate', tableName, data);
      const result = await originalUpdate.call(this, processedData, ...rest);
      return self.runHooks('afterUpdate', tableName, result);
    };

    qb.delete = qb.del = async function(...args: any[]) {
      await self.runHooks('beforeDelete', tableName, args);
      const result = await originalDelete.call(this, ...args);
      return self.runHooks('afterDelete', tableName, result);
    };

    qb.select = function(...fields: any[]) {
      const flatFields = fields.flat();
      const processedFields: string[] = [];

      for (const field of flatFields) {
        if (typeof field === 'string') {
          const parts = field.split('.');
          if (parts.length >= 2 && this._joinedRelations.has(parts[0])) {
            const relationName = parts[0];
            const columnName = parts[1];
            processedFields.push(`${relationName}.${columnName} as ${relationName}_${columnName}`);
          } else {
            processedFields.push(field);
          }
        } else {
          processedFields.push(field);
        }
      }

      return originalSelect.call(this, ...processedFields);
    };

    qb.then = function(onFulfilled: any, onRejected: any) {
      self.runHooks('beforeSelect', this, tableName);

      return originalThen.call(this, async (result: any) => {
        let processedResult = await self.runHooks('afterSelect', tableName, result);

        if (this._joinedRelations.size > 0) {
          const { nestJoinedData } = require('./utils/knex-helpers/nest-joined-data');
          const relations = Array.from(this._joinedRelations);
          processedResult = nestJoinedData(processedResult, relations, tableName);
        }

        return onFulfilled ? onFulfilled(processedResult) : processedResult;
      }, onRejected);
    };

    qb.relations = function(relationNames: string[], metadataGetter?: (tableName: string) => any) {
      if (!relationNames || relationNames.length === 0) return this;

      const getter = metadataGetter || ((tbl: string) => self.metadataCacheService?.lookupTableByName(tbl));
      applyRelations(this, tableName, relationNames, getter);
      relationNames.forEach(r => this._joinedRelations.add(r.split('.')[0]));

      return this;
    };

    return qb;
  }

  private async transformRelationsToFK(tableName: string, data: any): Promise<any> {
    if (!tableName) return data;

    const metadata = await this.metadataCacheService.getMetadata();
    const tableMeta = metadata.tables?.get?.(tableName) ||
                      metadata.tablesList?.find((t: any) => t.name === tableName);

    if (!tableMeta || !tableMeta.relations) return data;

    const transformed = { ...data };

    for (const relation of tableMeta.relations) {
      if (!['many-to-one', 'one-to-one'].includes(relation.type)) continue;

      const relName = relation.propertyName;
      const fkColumn = relation.foreignKeyColumn || `${relName}Id`;

      if (relName in transformed) {
        const relValue = transformed[relName];

        if (relValue === null) {
          transformed[fkColumn] = null;
          delete transformed[relName];
        } else if (typeof relValue === 'object' && relValue.id !== undefined) {
          transformed[fkColumn] = relValue.id;
          delete transformed[relName];
        } else if (typeof relValue === 'number' || typeof relValue === 'string') {
          transformed[fkColumn] = relValue;
          delete transformed[relName];
        } else {
          delete transformed[relName];
        }
      }
    }

    for (const relation of tableMeta.relations) {
      if (['one-to-many', 'many-to-many'].includes(relation.type)) {
        const relName = relation.propertyName;
        if (relName in transformed) delete transformed[relName];
      }
    }

    return transformed;
  }

  private async syncManyToManyRelations(tableName: string, data: any): Promise<void> {
    if (!tableName || !data.id) return;

    const metadata = await this.metadataCacheService.getMetadata();
    const tableMeta = metadata.tables?.get?.(tableName) ||
                      metadata.tablesList?.find((t: any) => t.name === tableName);

    if (!tableMeta || !tableMeta.relations) return;

    // Process M2M relations
    for (const relation of tableMeta.relations) {
      if (relation.type !== 'many-to-many') continue;
      
      const relationName = relation.propertyName;
      if (!(relationName in data)) continue;

      const junctionTable = relation.junctionTableName;
      const sourceColumn = relation.junctionSourceColumn;
      const targetColumn = relation.junctionTargetColumn;

      if (!junctionTable || !sourceColumn || !targetColumn) continue;

      const newIds = Array.isArray(data[relationName]) 
        ? data[relationName].map((item: any) => 
            typeof item === 'object' ? item.id : item
          ).filter((id: any) => id != null)
        : [];

      // Clear existing junction records
      await this.knexInstance(junctionTable)
        .where(sourceColumn, data.id)
        .delete();

      // Insert new junction records
      if (newIds.length > 0) {
        const junctionData = newIds.map((targetId: any) => ({
          [sourceColumn]: data.id,
          [targetColumn]: targetId,
        }));
        
        await this.knexInstance(junctionTable).insert(junctionData);
      }
    }
  }

  private async stripUnknownColumns(tableName: string, data: any): Promise<any> {
    if (!tableName) {
      return data;
    }

    const metadata = await this.metadataCacheService.getMetadata();
    const tableMeta = metadata.tables?.get?.(tableName) ||
                      metadata.tablesList?.find((t: any) => t.name === tableName);

    if (!tableMeta || !tableMeta.columns) {
      return data;
    }

    // Get list of valid column names
    const validColumns = new Set(tableMeta.columns.map((col: any) => col.name));

    // Also allow FK columns from relations
    if (tableMeta.relations) {
      for (const rel of tableMeta.relations) {
        if (rel.foreignKeyColumn) {
          validColumns.add(rel.foreignKeyColumn);
        }
      }
    }

    const stripped = { ...data };

    // Remove any field not in valid columns
    for (const key of Object.keys(stripped)) {
      if (!validColumns.has(key)) {
        delete stripped[key];
      }
    }

    return stripped;
  }

  private async convertDateFields(tableName: string, data: any): Promise<any> {
    if (!tableName || !data) {
      return data;
    }

    const metadata = await this.metadataCacheService.getMetadata();
    const tableMeta = metadata.tables?.get?.(tableName) ||
                      metadata.tablesList?.find((t: any) => t.name === tableName);

    if (!tableMeta || !tableMeta.columns) {
      return data;
    }

    const converted = { ...data };

    for (const column of tableMeta.columns) {
      const value = converted[column.name];

      if (value === null || value === undefined) {
        continue;
      }

      if (column.type === 'date' || column.type === 'datetime' || column.type === 'timestamp') {
        if (typeof value === 'string' && value.includes('T')) {
          const date = new Date(value);

          if (column.type === 'date') {
            converted[column.name] = date.toISOString().split('T')[0];
          } else if (column.type === 'datetime' || column.type === 'timestamp') {
            converted[column.name] = date.toISOString().slice(0, 19).replace('T', ' ');
          }
        }
      }
    }

    return converted;
  }

  private async stripNonUpdatableFields(tableName: string, data: any): Promise<any> {
    if (!tableName) {
      return data;
    }

    const metadata = await this.metadataCacheService.getMetadata();
    const tableMeta = metadata.tables?.get?.(tableName) || 
                      metadata.tablesList?.find((t: any) => t.name === tableName);
    
    if (!tableMeta || !tableMeta.columns) {
      return data;
    }

    const stripped = { ...data };
    
    for (const column of tableMeta.columns) {
      if (column.isUpdatable === false && column.name in stripped) {
        delete stripped[column.name];
      }
    }

    return stripped;
  }

  async onModuleDestroy() {
    this.logger.log('🔌 Destroying Knex connection...');
    if (this.knexInstance) {
      await this.knexInstance.destroy();
      this.logger.log('✅ Knex connection destroyed');
    }
  }

  getKnex(): ExtendedKnex {
    if (!this.knexInstance) {
      throw new Error('Knex instance not initialized. Call onModuleInit first.');
    }
    
    // Return a proxy that intercepts all knex calls and wraps query builders
    const self = this;
    return new Proxy(this.knexInstance, {
      get(target, prop) {
        const value = target[prop];
        
        // If accessing a method that might return a query builder, wrap it
        if (typeof value === 'function') {
          // Special handling for methods that return query builders
          if (prop === 'table' || prop === 'from' || prop === 'queryBuilder') {
            return function(...args: any[]) {
              const qb = value.apply(target, args);
              return self.wrapQueryBuilder(qb, target);
            };
          }
          
          // Bind other methods to the target but don't wrap
          return value.bind(target);
        }
        
        return value;
      },
      apply(target, thisArg, args: [string]) {
        // Intercept knex(tableName) calls
        const qb = Reflect.apply(target, thisArg, args);
        return self.wrapQueryBuilder(qb, target);
      },
    }) as ExtendedKnex;
  }

  async raw(sql: string, bindings?: any[]): Promise<any> {
    return await this.knexInstance.raw(sql, bindings);
  }

  async hasTable(tableName: string): Promise<boolean> {
    return await this.knexInstance.schema.hasTable(tableName);
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    return await this.knexInstance.schema.hasColumn(tableName, columnName);
  }

  async getTableNames(): Promise<string[]> {
    const DB_TYPE = this.configService.get<string>('DB_TYPE') || 'mysql';
    
    if (DB_TYPE === 'postgres') {
      const result = await this.knexInstance.raw(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
      `);
      return result.rows.map((row: any) => row.tablename);
    } else {
      const result = await this.knexInstance.raw(`
        SELECT TABLE_NAME 
        FROM information_schema.TABLES 
        WHERE TABLE_SCHEMA = DATABASE()
      `);
      return result[0].map((row: any) => row.TABLE_NAME);
    }
  }
  
  async insertWithAutoUUID(tableName: string, data: any | any[]): Promise<any> {
    const records = Array.isArray(data) ? data : [data];
    const tableColumns = this.columnTypesMap.get(tableName);
    const now = this.knexInstance.fn.now();
    
    if (tableColumns) {
      const { randomUUID } = await import('crypto');
      // Auto-generate UUID for UUID columns that are null/undefined
      for (const record of records) {
        for (const [colName, colType] of tableColumns.entries()) {
          if (colType === 'uuid' && (record[colName] === null || record[colName] === undefined)) {
            record[colName] = randomUUID();
          }
        }
        
        // Auto-add timestamps (runtime behavior, not metadata-driven)
        if (record.createdAt === undefined) {
          record.createdAt = now;
        }
          record.updatedAt = now;
        
      }
    }
    
    return await this.knexInstance(tableName).insert(Array.isArray(data) ? records : records[0]);
  }

  async transaction(callback: (trx: Knex.Transaction) => Promise<any>): Promise<any> {
    return await this.knexInstance.transaction(callback);
  }


  private autoParseJsonFields(result: any, queryContext?: any): any {
    if (!result) return result;

    // Get table name from query context
    const tableName = queryContext?.table || queryContext?.__knexQueryUid?.split('.')[0];

    // If no table name or no metadata for this table, return as-is
    if (!tableName || !this.columnTypesMap.has(tableName)) {
      return result;
    }

    // Get column types for this table
    const columnTypes = this.columnTypesMap.get(tableName)!;

    // Handle array of records
    if (Array.isArray(result)) {
      return result.map(record => this.parseRecord(record, columnTypes));
    }

    // Handle single record
    if (typeof result === 'object' && !Buffer.isBuffer(result)) {
      return this.parseRecord(result, columnTypes);
    }

    return result;
  }

  private parseRecord(record: any, columnTypes: Map<string, string>): any {
    if (!record || typeof record !== 'object') {
      return record;
    }

    const parsed = { ...record };

    // Parse JSON fields only
    for (const [fieldName, fieldType] of columnTypes) {
      if ((fieldType === 'simple-json' || fieldType === 'json') && 
          parsed[fieldName] && 
          typeof parsed[fieldName] === 'string') {
        try {
          parsed[fieldName] = JSON.parse(parsed[fieldName]);
        } catch (e) {
          // Keep as string if parse fails
        }
      }
    }

    return parsed;
  }

  async insertWithCascade(tableName: string, data: any): Promise<any> {
    // Auto-add timestamps (runtime behavior, not metadata-driven)
    // Skip timestamps for junction tables
    const isJunctionTable = tableName.includes('_') && 
                           (tableName.includes('_definition_') || 
                            tableName.includes('_methods_') ||
                            tableName.includes('_routes_') ||
                            tableName.includes('_permissions_'));
    
    if (!isJunctionTable) {
      const now = this.knexInstance.fn.now();
      if (data.createdAt === undefined) {
        data.createdAt = now;
      }
      if (data.updatedAt === undefined) {
        data.updatedAt = now;
      }
    }

    const metadata = await this.metadataCacheService.getMetadata();
    if (!metadata) {
      this.logger.warn('No metadata loaded - falling back to regular insert');
      return await this.knexInstance(tableName).insert(data);
    }

    return await this.relationHandler.insertWithCascade(
      this.knexInstance,
      tableName,
      data,
      metadata,
      this.dbType,
    );
  }

  async updateWithCascade(tableName: string, recordId: any, data: any): Promise<void> {
    // Remove createdAt from update data (should never be updated)
    const { createdAt, ...updateData } = data;
    
    // Auto-update updatedAt timestamp (runtime behavior, not metadata-driven)
    // Skip timestamps for junction tables
    const isJunctionTable = tableName.includes('_') && 
                           (tableName.includes('_definition_') || 
                            tableName.includes('_methods_') ||
                            tableName.includes('_routes_') ||
                            tableName.includes('_permissions_'));
    
    if (!isJunctionTable && updateData.updatedAt === undefined) {
      updateData.updatedAt = this.knexInstance.fn.now();
    } else if (!isJunctionTable && updateData.updatedAt && typeof updateData.updatedAt === 'string') {
      // Convert ISO string to MySQL datetime format
      updateData.updatedAt = this.knexInstance.fn.now();
    }

    const metadata = await this.metadataCacheService.getMetadata();
    if (!metadata) {
      this.logger.warn('No metadata loaded - falling back to regular update');
      await this.knexInstance(tableName).where('id', recordId).update(updateData);
      return;
    }

    return await this.relationHandler.updateWithCascade(
      this.knexInstance,
      tableName,
      recordId,
      updateData,
      metadata,
      this.dbType,
    );
  }

  async preprocessData(tableName: string, data: any) {
    const metadata = await this.metadataCacheService.getMetadata();
    if (!metadata) {
      return { cleanData: data, manyToManyRelations: [], oneToManyRelations: [] };
    }

    return this.relationHandler.preprocessData(tableName, data, metadata);
  }


}
