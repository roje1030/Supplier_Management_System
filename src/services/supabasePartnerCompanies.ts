import { supabase, isSupabaseConfigured } from './supabaseClient';
import {
  BranchRecord,
  BranchStatus,
  ComplianceDocument,
  PartnerCompany,
  PartnerCompanyType,
  SupplierOrigin,
  AccreditationStatus,
} from '../types/survey';

type SupabaseBranchValue = Record<string, unknown>;

export interface SupabasePartnerCompanyRow {
  id: string;
  name: string;
  type: string;
  supplier_origin?: string | null;
  email?: string | null;
  affiliation?: string | null;
  created_at?: string | null;
  registered_at?: string | null;
  is_archived?: boolean | null;
  accreditation_status?: string | null;
  evaluation_rank?: number | null;
  branches?: unknown;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  }
  return undefined;
}

function pick(value: SupabaseBranchValue, keys: string[]): unknown {
  for (const key of keys) {
    if (key in value && value[key] !== null && value[key] !== undefined && String(value[key]).trim() !== '') {
      return value[key];
    }
  }
  return undefined;
}

function normalizeAccreditationStatus(value: unknown): AccreditationStatus | undefined {
  const status = asString(value);
  if (status === 'Accredited' || status === 'Unaccredited') return status;
  return undefined;
}

function normalizeSupplierOrigin(value: unknown): SupplierOrigin | undefined {
  const origin = asString(value);
  if (origin === 'Local' || origin === 'Foreign') return origin;
  return undefined;
}

function normalizePartnerCompanyType(value: unknown): PartnerCompanyType {
  if (value === 'Courier' || value === 'Supplier' || value === 'Subcontractor' || value === 'Uncategorized') {
    return value;
  }
  if (value === 'Contractor') return 'Courier';
  return 'Uncategorized';
}

function normalizeBranchStatus(value: unknown): BranchStatus | undefined {
  const status = asString(value);
  if (
    status === 'Pending' ||
    status === 'Updated' ||
    status === 'Outdated' ||
    status === 'Incomplete' ||
    status === 'Completed' ||
    status === 'Inactive' ||
    status === 'Accredited'
  ) {
    return status;
  }
  return undefined;
}

function normalizeDocuments(value: unknown): Record<string, ComplianceDocument> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, ComplianceDocument>;
}

function normalizeBranch(branch: unknown, companyId: string, index: number): BranchRecord {
  const raw = (branch && typeof branch === 'object' && !Array.isArray(branch) ? branch : {}) as SupabaseBranchValue;
  const id = asString(pick(raw, ['id', 'branch_id', 'branchId'])) || `${companyId}-branch-${index + 1}`;

  return {
    id,
    bpCode: asString(pick(raw, ['bpCode', 'bp_code', 'bpcode'])) || '',
    address: asString(pick(raw, ['address', 'bpAddress', 'bp_address'])),
    federalTaxId: asString(pick(raw, ['federalTaxId', 'federal_tax_id', 'taxId', 'tax_id'])),
    industry: asString(pick(raw, ['industry'])),
    contactPerson: asString(pick(raw, ['contactPerson', 'contact_person'])),
    position: asString(pick(raw, ['position'])),
    mobilePhone: asString(pick(raw, ['mobilePhone', 'mobile_phone', 'phone'])),
    email: asString(pick(raw, ['email'])),
    rawCategory: asString(pick(raw, ['rawCategory', 'raw_category', 'category'])),
    supplierRank: asString(pick(raw, ['supplierRank', 'supplier_rank'])),
    dateAccredited: asString(pick(raw, ['dateAccredited', 'date_accredited', 'registeredAt', 'registered_at'])),
    status: normalizeBranchStatus(pick(raw, ['status'])),
    sourceRow: asNumber(pick(raw, ['sourceRow', 'source_row'])),
    documents: normalizeDocuments(pick(raw, ['documents'])) ?? {},
  };
}

export function normalizePartnerCompanyRow(row: SupabasePartnerCompanyRow): PartnerCompany {
  const branchesRaw = Array.isArray(row.branches) ? row.branches : [];
  return {
    id: row.id,
    name: row.name,
    type: normalizePartnerCompanyType(row.type),
    supplierOrigin: normalizeSupplierOrigin(row.supplier_origin),
    email: asString(row.email),
    affiliation: asString(row.affiliation),
    createdAt: row.created_at ?? new Date().toISOString(),
    registeredAt: row.registered_at ?? undefined,
    isArchived: row.is_archived ?? false,
    accreditationStatus: normalizeAccreditationStatus(row.accreditation_status),
    evaluationRank: asNumber(row.evaluation_rank),
    branches: branchesRaw.map((branch, index) => normalizeBranch(branch, row.id, index)),
  };
}

export function toSupabasePartnerCompanyRow(company: PartnerCompany): SupabasePartnerCompanyRow {
  return {
    id: company.id,
    name: company.name,
    type: company.type,
    supplier_origin: company.supplierOrigin ?? null,
    email: company.email ?? null,
    affiliation: company.affiliation ?? null,
    created_at: company.createdAt,
    registered_at: company.registeredAt ?? null,
    is_archived: company.isArchived ?? false,
    accreditation_status: company.accreditationStatus ?? null,
    evaluation_rank: company.evaluationRank ?? null,
    branches: company.branches ?? [],
  };
}

export async function fetchPartnerCompanies(): Promise<PartnerCompany[]> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const { data, error } = await supabase
    .from('partner_companies')
    .select('id, name, type, supplier_origin, email, affiliation, created_at, registered_at, is_archived, accreditation_status, evaluation_rank, branches')
    .order('name', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => normalizePartnerCompanyRow(row as SupabasePartnerCompanyRow));
}

export async function syncPartnerCompanies(companies: PartnerCompany[]): Promise<void> {
  if (!isSupabaseConfigured || companies.length === 0) return;

  const { error } = await supabase
    .from('partner_companies')
    .upsert(companies.map(toSupabasePartnerCompanyRow), { onConflict: 'id' });

  if (error) {
    throw new Error(error.message);
  }
}

export async function replacePartnerCompanies(companies: PartnerCompany[]): Promise<void> {
  if (!isSupabaseConfigured) return;

  const existing = await supabase.from('partner_companies').select('id');
  if (existing.error) {
    throw new Error(existing.error.message);
  }

  const keepIds = new Set(companies.map((company) => company.id));
  const removeIds = (existing.data ?? [])
    .map((row) => (row as { id?: string }).id)
    .filter((id): id is string => Boolean(id) && !keepIds.has(id));

  if (companies.length > 0) {
    await syncPartnerCompanies(companies);
  }

  if (removeIds.length > 0) {
    const { error } = await supabase.from('partner_companies').delete().in('id', removeIds);
    if (error) {
      throw new Error(error.message);
    }
  }
}

export async function deletePartnerCompany(id: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from('partner_companies').delete().eq('id', id);
  if (error) {
    throw new Error(error.message);
  }
}