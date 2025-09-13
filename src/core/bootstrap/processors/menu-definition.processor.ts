import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BaseTableProcessor, UpsertResult } from './base-table-processor';

@Injectable()
export class MenuDefinitionProcessor extends BaseTableProcessor {
  async transformRecords(records: any[], context: { repo: Repository<any> }): Promise<any[]> {
    const { repo } = context;
    const sidebarCache = new Map();
    const parentCache = new Map();

    // First, ensure all sidebars and potential parents exist
    for (const record of records) {
      if (record.type === 'Mini Sidebar') {
        let existing = await repo.findOne({
          where: { type: 'Mini Sidebar', label: record.label }
        });

        if (!existing) {
          existing = await repo.save(repo.create(record));
          this.logger.debug(`Created sidebar "${record.label}" with id ${existing.id}`);
        }
        sidebarCache.set(record.label, existing.id);
      }
    }

    // Then ensure all potential parents exist
    for (const record of records) {
      if (record.parent && typeof record.parent === 'string') {
        if (!parentCache.has(record.parent)) {
          let existing = await repo.findOne({
            where: { label: record.parent }
          });

          if (!existing) {
            // Find parent record in current batch
            const parentRecord = records.find(r => r.label === record.parent);
            if (parentRecord) {
              existing = await repo.save(repo.create(parentRecord));
              this.logger.debug(`Created parent "${record.parent}" with id ${existing.id}`);
            }
          }

          if (existing) {
            parentCache.set(record.parent, existing.id);
          }
        }
      }
    }

    // Then process all records and replace string references with IDs
    const transformedRecords = [];

    for (const record of records) {
      const transformed = { ...record };

      // Replace sidebar string with ID object
      if (transformed.sidebar && typeof transformed.sidebar === 'string') {
        const sidebarId = sidebarCache.get(transformed.sidebar);
        if (sidebarId) {
          transformed.sidebar = { id: sidebarId };
        } else {
          delete transformed.sidebar;
          this.logger.warn(`Sidebar "${record.sidebar}" not found for menu item "${record.label}"`);
        }
      }

      // Handle parent references
      if (transformed.parent && typeof transformed.parent === 'string') {
        const parentId = parentCache.get(transformed.parent);
        if (parentId) {
          transformed.parent = { id: parentId };
        } else {
          delete transformed.parent;
          this.logger.warn(`Parent "${record.parent}" not found for menu item "${record.label}"`);
        }
      }

      // Only add records that haven't been created yet
      if (record.type !== 'Mini Sidebar' && !parentCache.has(record.label)) {
        transformedRecords.push(transformed);
      }
    }

    return transformedRecords;
  }

  getUniqueIdentifier(record: any): object[] {
    if (record.type === 'Mini Sidebar' || record.type === 'mini') {
      // For mini sidebars, check by type + label
      return [{ type: record.type, label: record.label }];
    } else if (record.type === 'Menu' || record.type === 'menu' || record.type === 'Dropdown Menu') {
      // For menu items and dropdown menus, try multiple strategies
      const conditions = [];
      
      // If has sidebar, try with sidebar first
      if (record.sidebar) {
        conditions.push({ type: record.type, label: record.label, sidebar: record.sidebar });
      }
      
      // Always add fallback without sidebar
      conditions.push({ type: record.type, label: record.label });
      
      return conditions;
    }
    
    // Fallback for other types
    return [{ type: record.type, label: record.label }];
  }

  protected getCompareFields(): string[] {
    return ['label', 'icon', 'path', 'isEnabled', 'description', 'order', 'permission'];
  }

  protected getRecordIdentifier(record: any): string {
    const type = record.type;
    const label = record.label;
    const sidebar = record.sidebar;
    
    if (type === 'Mini Sidebar' || type === 'mini') {
      return `[Mini Sidebar] ${label}`;
    } else if (type === 'Dropdown Menu') {
      return `[Dropdown Menu] ${label}${sidebar ? ` (sidebar: ${sidebar})` : ''}`;
    } else if (type === 'Menu' || type === 'menu') {
      return `[Menu] ${label}${sidebar ? ` (sidebar: ${sidebar})` : ''} -> ${record.path || 'no-path'}`;
    }
    
    return `[${type}] ${label}`;
  }
}