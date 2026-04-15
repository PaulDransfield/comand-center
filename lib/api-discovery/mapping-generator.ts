// lib/api-discovery/mapping-generator.ts
// Converts discovered API mappings into sync engine configuration

interface DiscoveredMapping {
  fortnox_field: string
  commandcenter_table: string
  commandcenter_field: string
  confidence: number
  reasoning: string
  endpoint: string
  provider: string
}

interface SyncEngineMapping {
  endpoint: string
  table: string
  field_mappings: Array<{
    source: string
    target: string
    transform?: string
    required: boolean
  }>
  date_field?: string
  amount_field?: string
  id_field?: string
}

export function generateSyncEngineConfig(discoveries: DiscoveredMapping[]): SyncEngineMapping[] {
  // Group by endpoint
  const byEndpoint: Record<string, DiscoveredMapping[]> = {}
  
  for (const mapping of discoveries) {
    if (!byEndpoint[mapping.endpoint]) {
      byEndpoint[mapping.endpoint] = []
    }
    byEndpoint[mapping.endpoint].push(mapping)
  }
  
  const configs: SyncEngineMapping[] = []
  
  for (const [endpoint, mappings] of Object.entries(byEndpoint)) {
    // Sort by confidence (highest first)
    mappings.sort((a, b) => b.confidence - a.confidence)
    
    const config: SyncEngineMapping = {
      endpoint,
      table: mappings[0].commandcenter_table, // Use table from first mapping
      field_mappings: [],
      date_field: undefined,
      amount_field: undefined,
      id_field: undefined
    }
    
    // Process each mapping
    for (const mapping of mappings) {
      // Skip low confidence mappings
      if (mapping.confidence < 70) continue
      
      const fieldMapping = {
        source: mapping.fortnox_field,
        target: mapping.commandcenter_field,
        required: mapping.confidence >= 85,
        transform: getTransformation(mapping.fortnox_field, mapping.commandcenter_field)
      }
      
      config.field_mappings.push(fieldMapping)
      
      // Identify special fields
      if (mapping.commandcenter_field.includes('date') || mapping.commandcenter_field.includes('Date')) {
        config.date_field = mapping.fortnox_field
      }
      
      if (mapping.commandcenter_field.includes('amount') || 
          mapping.commandcenter_field.includes('revenue') || 
          mapping.commandcenter_field.includes('cost') ||
          mapping.commandcenter_field.includes('price')) {
        config.amount_field = mapping.fortnox_field
      }
      
      if (mapping.commandcenter_field.includes('source_id') || 
          mapping.commandcenter_field.includes('id') && 
          !mapping.commandcenter_field.includes('vendor') &&
          !mapping.commandcenter_field.includes('staff') &&
          !mapping.commandcenter_field.includes('product')) {
        config.id_field = mapping.fortnox_field
      }
    }
    
    // Add default mappings for required fields
    addDefaultMappings(config, endpoint)
    
    configs.push(config)
  }
  
  return configs
}

function getTransformation(sourceField: string, targetField: string): string | undefined {
  // Date transformations
  if (targetField.includes('date') || targetField.includes('Date')) {
    return 'parseDate'
  }
  
  // Amount transformations (convert to numeric)
  if (targetField.includes('amount') || 
      targetField.includes('revenue') || 
      targetField.includes('cost') ||
      targetField.includes('price')) {
    return 'parseFloat'
  }
  
  // ID transformations (add prefix)
  if (targetField === 'source_id') {
    if (sourceField.includes('Invoice') || sourceField.includes('invoice')) {
      return 'v => `inv-${v}`'
    }
    if (sourceField.includes('Number') || sourceField.includes('number')) {
      return 'v => `num-${v}`'
    }
  }
  
  return undefined
}

function addDefaultMappings(config: SyncEngineMapping, endpoint: string) {
  // Ensure we have required fields
  const hasDateField = config.field_mappings.some(f => 
    f.target.includes('date') || f.target.includes('Date'))
  
  const hasAmountField = config.field_mappings.some(f => 
    f.target.includes('amount') || 
    f.target.includes('revenue') || 
    f.target.includes('cost') ||
    f.target.includes('price'))
  
  const hasIdField = config.field_mappings.some(f => f.target === 'source_id')
  
  // Add provider field
  if (!config.field_mappings.some(f => f.target === 'provider')) {
    config.field_mappings.push({
      source: `'${config.endpoint.includes('supplier') ? 'fortnox' : 'fortnox-revenue'}'`,
      target: 'provider',
      required: true,
      transform: undefined
    })
  }
  
  // Add period_year and period_month from date field if we have one
  if (config.date_field && !config.field_mappings.some(f => f.target === 'period_year')) {
    config.field_mappings.push({
      source: config.date_field,
      target: 'period_year',
      required: false,
      transform: 'v => new Date(v).getFullYear()'
    })
    
    config.field_mappings.push({
      source: config.date_field,
      target: 'period_month',
      required: false,
      transform: 'v => new Date(v).getMonth() + 1'
    })
  }
}

// Generate TypeScript code for sync engine
export function generateSyncEngineCode(configs: SyncEngineMapping[]): string {
  let code = `// Auto-generated sync engine configuration for Fortnox
// Generated by API Schema Discovery Agent on ${new Date().toISOString().slice(0, 10)}

export const FORTNOX_SYNC_CONFIG = {
  endpoints: {\n`
  
  for (const config of configs) {
    const endpointName = config.endpoint.replace('/', '').replace(/[^a-zA-Z]/g, '_')
    
    code += `    ${endpointName}: {\n`
    code += `      path: '${config.endpoint}',\n`
    code += `      table: '${config.table}',\n`
    
    if (config.date_field) {
      code += `      date_field: '${config.date_field}',\n`
    }
    
    if (config.amount_field) {
      code += `      amount_field: '${config.amount_field}',\n`
    }
    
    if (config.id_field) {
      code += `      id_field: '${config.id_field}',\n`
    }
    
    code += `      mappings: [\n`
    
    for (const mapping of config.field_mappings) {
      code += `        {\n`
      code += `          source: '${mapping.source}',\n`
      code += `          target: '${mapping.target}',\n`
      code += `          required: ${mapping.required},\n`
      
      if (mapping.transform) {
        code += `          transform: ${mapping.transform},\n`
      }
      
      code += `        },\n`
    }
    
    code += `      ],\n`
    code += `    },\n`
  }
  
  code += `  }\n};\n\n`
  
  // Add helper functions
  code += `// Helper functions for transformations
function parseDate(value: any): string | null {
  if (!value) return null
  try {
    return new Date(value).toISOString().slice(0, 10)
  } catch {
    return null
  }
}

function parseFloat(value: any): number | null {
  if (value === null || value === undefined) return null
  const num = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]/g, '')) : Number(value)
  return isNaN(num) ? null : num
}\n`
  
  return code
}

// Generate SQL for new tables if needed
export function generateTableSQL(configs: SyncEngineMapping[]): string[] {
  const tables = new Set<string>()
  const sqlStatements: string[] = []
  
  // Collect unique tables
  for (const config of configs) {
    tables.add(config.table)
  }
  
  // Generate CREATE TABLE statements for tables that don't exist
  for (const table of tables) {
    // Skip tables we know exist
    const existingTables = [
      'financial_logs', 'revenue_logs', 'staff_logs', 'products_logs',
      'api_discoveries', 'integrations', 'organisations', 'businesses'
    ]
    
    if (existingTables.includes(table)) continue
    
    // Generate CREATE TABLE statement
    const sql = `CREATE TABLE IF NOT EXISTS ${table} (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT,
  source_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, business_id, provider, source_id)
);
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
CREATE POLICY "${table}_select_own" ON ${table}
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));`
    
    sqlStatements.push(sql)
  }
  
  return sqlStatements
}