import { useEffect, useMemo, useRef, useState } from 'react';
import { sharePointService } from '../services/sharepointService';
import { QuestionDefinition, ResponseNotification, SurveyResponse, SurveyType, CustomForm, Rating, PartnerCompany, PartnerCompanyType, BranchRecord, ArchiveSeries, SupplierOrigin } from '../types/survey';
import { surveyQuestions } from '../data/questions';
import { generateMockResponses, generateAllMockResponses, generateSingleMockResponse, generateBulkMockResponses } from '../data/mockResponses';
import { importMasterListFromFile, ImportResult } from '../utils/masterListImport';
import { importArchivedResponsesFromFile, ArchiveImportResult } from '../utils/archiveResponseTransfer';
import {
  previewRawEvaluationImport as previewRawEvaluationImportFile,
  commitRawEvaluationImport as commitRawEvaluationImportRows,
  RawEvalPreview,
  RawEvalImportSummary,
  CompanyDecision,
} from '../utils/rawEvaluationImport';
import { SimClock, getEffectiveNow, getEffectiveTodayStr } from '../utils/simClock';
import { logAdminActivity } from '../utils/adminActivityLog';
import { computeCompanyDocumentSummary, computeDocumentStatus, EXPIRING_SOON_DAYS } from '../utils/compliance';
import { getRequiredDocumentKeys } from '../utils/documentRequirements';
import { getNotificationSettings, NOTIFICATION_SETTINGS_CHANGED_EVENT } from '../utils/documentNotificationSettings';
import { insertSurveyResponses, fetchSurveyResponses } from '../services/supabaseResponses';
import { deletePartnerCompany as deletePartnerCompanyFromSupabase, fetchPartnerCompanies, replacePartnerCompanies, syncPartnerCompanies } from '../services/supabasePartnerCompanies';
import { isSupabaseConfigured } from '../services/supabaseClient';
import { CATEGORIES_STORAGE_KEY, DEFAULT_CATEGORIES, LEGACY_OVERALL_CATEGORY, OVERALL_CATEGORY, getStoredCategoryLabels } from '../data/questionCategories';

const NOTIFICATION_HISTORY_LIMIT = 200;
const INITIAL_NOTIFICATION_SEED = 15;
const ALL_DEPARTMENTS = [
  'Accounts Payable - Trade',
  'Business Solutions Manager',
  'Executive Office',
  'Logistics',
  'Procurement Group',
  'TASS'
];
const ALL_SURVEY_ACCESS_ROLES = ['Rank & File', 'Supervisory', 'Managerial', 'Director', 'Executive'] as const;

function normalizeSurveyType(value: unknown): SurveyType {
  if (value === 'Contractor') return 'Courier';
  if (value === 'Courier' || value === 'Supplier' || value === 'Subcontractor') return value;
  return 'Courier';
}

function ensureOverallFeedbackQuestion(form: CustomForm): CustomForm {
  const expectedId = 
    form.surveyType === 'Courier' ? 'Q-CON-OVERALL-FEEDBACK' :
    form.surveyType === 'Supplier' ? 'Q-SUP-OVERALL-FEEDBACK' :
    'Q-SUB-OVERALL-FEEDBACK';

  const hasQuestion = form.questions.some(q => q.questionId === expectedId);
  if (hasQuestion) {
    return form;
  }

  const maxNum = form.questions.reduce((max, q) => Math.max(max, q.questionNumber || 0), 0);
  const nextNum = maxNum + 1;

  const feedbackQuestion = {
    questionId: expectedId,
    questionNumber: nextNum,
    question: 'Overall Comments and Feedback on the Company',
    questionCategory: OVERALL_CATEGORY,
    section: 'Overall Comments & Feedback',
    inputType: 'text' as const
  };

  return {
    ...form,
    questions: [...form.questions, feedbackQuestion]
  }
}

// One-time self-healing migration: questions saved before the "Overall"
// category existed carry the old 'General' label - rewrite them in place so
// the survey editor's dropdown (which only offers Overall, not General) and
// every chart/report grouping by questionCategory show one consistent name.
function migrateGeneralCategory(form: CustomForm): CustomForm {
  const hasLegacy = form.questions.some((q) => q.questionCategory === LEGACY_OVERALL_CATEGORY);
  if (!hasLegacy) return form;
  return {
    ...form,
    questions: form.questions.map((q) =>
      q.questionCategory === LEGACY_OVERALL_CATEGORY ? { ...q, questionCategory: OVERALL_CATEGORY } : q
    ),
  };
}

function normalizeCustomForm(form: CustomForm): CustomForm {
  const normForm = {
    ...form,
    surveyType: normalizeSurveyType(form.surveyType),
    accessDepartments: form.accessDepartments?.length ? form.accessDepartments : ALL_DEPARTMENTS,
    accessRoles: form.accessRoles?.length ? form.accessRoles : [...ALL_SURVEY_ACCESS_ROLES],
  };
  return migrateGeneralCategory(ensureOverallFeedbackQuestion(normForm));
}

function normalizePartnerCompanyType(value: unknown): PartnerCompanyType {
  if (value === 'Contractor') return 'Courier';
  if (value === 'Courier' || value === 'Supplier' || value === 'Subcontractor' || value === 'Uncategorized') return value;
  return 'Courier';
}

function normalizePartnerCompany(company: PartnerCompany): PartnerCompany {
  const defaultRegisteredAt = company.createdAt ? company.createdAt.split('T')[0] : '2025-01-15';

  const normalizedType = normalizePartnerCompanyType(company.type);

  // Every company gets at least one branch record so downstream UI (branch
  // list, compliance documents) never has to special-case "hasn't been
  // migrated yet". A company that already has branches (e.g. from a future
  // master-list import) keeps them as-is.
  const defaultBranches: BranchRecord[] =
    company.branches && company.branches.length > 0
      ? company.branches
      : [{ id: `${company.id}-branch-1`, bpCode: '' }];

  return {
    ...company,
    type: normalizedType,
    registeredAt: company.registeredAt ?? defaultRegisteredAt,
    isArchived: company.isArchived ?? false,
    accreditationStatus: company.accreditationStatus ?? (normalizedType === 'Uncategorized' ? 'Unaccredited' : 'Accredited'),
    // Only Suppliers carry a Local/Foreign origin. Legacy seeded suppliers
    // predate this distinction, so default them to Local (all known to be
    // local vendors) unless already set.
    supplierOrigin: normalizedType === 'Supplier' ? (company.supplierOrigin ?? 'Local') : undefined,
    branches:
      company.branches && company.branches.length > 0
        ? company.branches.map((branch) => ({
            ...branch,
            documents: { ...(branch.documents ?? {}) },
          }))
        : defaultBranches,
  };
}

function normalizeSurveyResponse(response: SurveyResponse): SurveyResponse {
  return {
    ...response,
    surveyType: normalizeSurveyType(response.surveyType),
    questionCategory: response.questionCategory === LEGACY_OVERALL_CATEGORY ? OVERALL_CATEGORY : response.questionCategory,
  };
}

function toNotification(rows: SurveyResponse[]): ResponseNotification | null {
  const first = rows[0];
  if (!first) return null;

  // Determine email
  let email = first.respondentEmail;
  if (!email) {
    const cleanType = first.respondentType.toLowerCase();
    if (cleanType.includes('rank') || cleanType.includes('file')) {
      email = 'miguel.santos@mgenesis.com';
    } else if (cleanType.includes('super')) {
      email = 'denise.aquino@mgenesis.com';
    } else if (cleanType.includes('manag')) {
      email = 'angela.reyes@mgenesis.com';
    } else if (cleanType.includes('direct')) {
      email = 'patricia.navarro@mgenesis.com';
    } else if (cleanType.includes('exec')) {
      email = 'rafael.concepcion@mgenesis.com';
    } else {
      email = 'miguel.santos@mgenesis.com';
    }
  }

  // Determine designation
  let designation = first.respondentType;
  const normalized = email.trim().toLowerCase();
  if (normalized === 'admin@mgenesis.com') designation = 'Executive';
  else if (normalized === 'miguel.santos@mgenesis.com') designation = 'Rank & File';
  else if (normalized === 'denise.aquino@mgenesis.com') designation = 'Supervisory';
  else if (normalized === 'angela.reyes@mgenesis.com') designation = 'Managerial';
  else if (normalized === 'patricia.navarro@mgenesis.com') designation = 'Director';
  else if (normalized === 'rafael.concepcion@mgenesis.com') designation = 'Executive';

  return {
    id: first.responseId,
    company: first.company,
    surveyType: first.surveyType,
    respondentType: first.respondentType,
    submissionDate: first.submissionDate,
    questionCount: rows.length,
    respondentEmail: email,
    department: first.department || 'Logistics',
    designation: designation,
  };
}

// Group responses by responseId to create proper individual notifications
function groupResponsesToNotifications(allResponses: SurveyResponse[]): ResponseNotification[] {
  const grouped: Record<string, SurveyResponse[]> = {};
  allResponses.forEach((r) => {
    if (!grouped[r.responseId]) {
      grouped[r.responseId] = [];
    }
    grouped[r.responseId].push(r);
  });

  return Object.values(grouped)
    .map((rows) => toNotification(rows))
    .filter((item): item is ResponseNotification => item !== null)
    .sort((a, b) => b.submissionDate.localeCompare(a.submissionDate));
}

// Fallback synthetic pool used only if no accounts are supplied to the hook
// (e.g. very first render before account state is available). In normal
// operation this is fully replaced by the live account roster below.
const FALLBACK_NON_ADMIN_USERS = [
  { rType: 'Rank & File', dept: 'Logistics', email: 'miguel.santos@mgenesis.com' },
  { rType: 'Supervisory', dept: 'Logistics', email: 'denise.aquino@mgenesis.com' },
  { rType: 'Managerial', dept: 'Procurement Group', email: 'angela.reyes@mgenesis.com' },
  { rType: 'Director', dept: 'TASS', email: 'patricia.navarro@mgenesis.com' },
  { rType: 'Executive', dept: 'Executive Office', email: 'rafael.concepcion@mgenesis.com' }
];

// Minimal shape needed from an account record — kept structural (not imported
// from App.tsx) to avoid a circular import between the hook and the app shell.
export interface SimulatableAccount {
  email: string;
  role: string;
  designation: string;
  department: string;
}

interface CompressedSubmission {
  i: string; // responseId
  t: SurveyType; // surveyType
  r: string; // respondentType
  st?: string; // startTime
  s: string; // submissionDate
  c: string; // company
  d?: string; // department
  ad?: string; // address
  e?: string; // respondentEmail
  ar?: boolean; // archived
  aat?: string; // archivedAt
  asi?: string; // archivedBySurveyId
  ast?: string; // archivedBySurveyTitle
  si?: string; // seriesId
  a: { // answers
    q: string; // questionId
    n: number; // questionNumber
    x: string; // question
    g: string; // questionCategory
    v: Rating; // rating
    m: string; // comment
  }[];
}

function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.error(`Failed to save key "${key}" to localStorage:`, error);
    return false;
  }
}

function compressResponses(responses: SurveyResponse[]): CompressedSubmission[] {
  const map = new Map<string, CompressedSubmission>();
  
  for (const resp of responses) {
    let comp = map.get(resp.responseId);
    if (!comp) {
      comp = {
        i: resp.responseId,
        t: resp.surveyType,
        r: resp.respondentType,
        s: resp.submissionDate,
        c: resp.company,
        a: []
      };
      if (resp.startTime !== undefined) comp.st = resp.startTime;
      if (resp.department !== undefined) comp.d = resp.department;
      if (resp.address !== undefined) comp.ad = resp.address;
      if (resp.respondentEmail !== undefined) comp.e = resp.respondentEmail;
      if (resp.archived !== undefined) comp.ar = resp.archived;
      if (resp.archivedAt !== undefined) comp.aat = resp.archivedAt;
      if (resp.archivedBySurveyId !== undefined) comp.asi = resp.archivedBySurveyId;
      if (resp.archivedBySurveyTitle !== undefined) comp.ast = resp.archivedBySurveyTitle;
      if (resp.seriesId !== undefined) comp.si = resp.seriesId;

      map.set(resp.responseId, comp);
    }
    comp.a.push({
      q: resp.questionId,
      n: resp.questionNumber,
      x: resp.question,
      g: resp.questionCategory,
      v: resp.rating,
      m: resp.comment
    });
  }
  
  return Array.from(map.values());
}

function decompressResponses(compressed: any[]): SurveyResponse[] {
  if (!Array.isArray(compressed)) return [];
  if (compressed.length === 0) return [];
  
  // If the elements are in the old uncompressed format, return them directly
  if ('responseId' in compressed[0]) {
    return compressed as SurveyResponse[];
  }
  
  const responses: SurveyResponse[] = [];
  for (const item of compressed as CompressedSubmission[]) {
    for (const ans of item.a) {
      const resp: SurveyResponse = {
        responseId: item.i,
        surveyType: item.t,
        respondentType: item.r,
        submissionDate: item.s,
        company: item.c,
        questionId: ans.q,
        questionNumber: ans.n,
        question: ans.x,
        questionCategory: ans.g,
        rating: ans.v,
        comment: ans.m
      };
      if (item.st !== undefined) resp.startTime = item.st;
      if (item.d !== undefined) resp.department = item.d;
      if (item.ad !== undefined) resp.address = item.ad;
      if (item.e !== undefined) resp.respondentEmail = item.e;
      if (item.ar !== undefined) resp.archived = item.ar;
      if (item.aat !== undefined) resp.archivedAt = item.aat;
      if (item.asi !== undefined) resp.archivedBySurveyId = item.asi;
      if (item.ast !== undefined) resp.archivedBySurveyTitle = item.ast;
      if (item.si !== undefined) resp.seriesId = item.si;

      responses.push(resp);
    }
  }
  
  return responses;
}

export function useSurveyData(accounts: SimulatableAccount[] = [], currentUserEmail?: string | null, isAdmin?: boolean, simClock: SimClock | null = null) {
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [surveys, setSurveys] = useState<CustomForm[]>([]);
  const [partnerCompanies, setPartnerCompanies] = useState<PartnerCompany[]>([]);
  const [categoryLabels, setCategoryLabels] = useState<Record<SurveyType, string[]>>(() => getStoredCategoryLabels());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<ResponseNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const [archiveSeries, setArchiveSeries] = useState<ArchiveSeries[]>(() => {
    try {
      const data = localStorage.getItem('survey_archive_series_v1');
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  });

  // Resolves a freeform label to an existing series (case-insensitive match)
  // or creates+persists a new one. Returns the series id to stamp onto
  // responses being archived.
  const getOrCreateSeries = (label: string): string => {
    const trimmed = label.trim();
    const existing = archiveSeries.find((s) => s.label.trim().toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;

    const newSeries: ArchiveSeries = {
      id: `series-${Date.now()}`,
      label: trimmed,
      createdAt: new Date().toISOString(),
    };
    const updated = [...archiveSeries, newSeries];
    setArchiveSeries(updated);
    safeSetItem('survey_archive_series_v1', JSON.stringify(updated));
    return newSeries.id;
  };

  const renameArchiveSeries = (id: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    const updated = archiveSeries.map((s) => (s.id === id ? { ...s, label: trimmed } : s));
    setArchiveSeries(updated);
    safeSetItem('survey_archive_series_v1', JSON.stringify(updated));
  };

  const [isFullDatasetActive, setIsFullDatasetActive] = useState(() => {
    return localStorage.getItem('survey_analytics_full_dataset_active') === 'true';
  });
  const isMountedRef = useRef(true);

  // Initialize and load surveys & responses
  useEffect(() => {
    isMountedRef.current = true;

    async function initData() {
      let loadErrorMessage: string | null = null;
      try {
        setIsLoading(true);

        // One-time production reset ("treat it as no data yet"): any browser
        // that was used during the demo/simulation phase is wiped clean the
        // first time it loads this build - stale simulated surveys, responses,
        // the full-dataset flag, and the time-travel clock all cleared - so
        // every user starts from the migrated, empty state with closed
        // surveys. The Partner Companies master list is deliberately NOT
        // touched here (it is real reference data, not simulation).
        if (localStorage.getItem('survey_analytics_migration_v7_fresh') !== 'true') {
          localStorage.removeItem('survey_analytics_surveys_v6');
          localStorage.removeItem('survey_analytics_responses_v6');
          localStorage.removeItem('survey_analytics_full_dataset_active');
          localStorage.removeItem('survey_sim_clock_v1');
          localStorage.setItem('survey_analytics_migration_v7_fresh', 'true');
        }

        // 1. Handle Surveys (Forms)
        let loadedSurveys: CustomForm[] = [];
        const savedSurveys = localStorage.getItem('survey_analytics_surveys_v6');
        if (savedSurveys) {
          loadedSurveys = JSON.parse(savedSurveys).map(normalizeCustomForm);
          localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(loadedSurveys));
        } else {
          // Create 3 standard default surveys based on initial static questions
          const contractorQuestions = [
            {
              questionId: 'Q-CON-03',
              questionNumber: 1,
              question: 'Period Covered',
              questionCategory: 'General',
              section: 'SECTION 2',
              inputType: 'select' as const,
              options: [
                '1st Half',
                '2nd Half',
                'Annual'
              ]
            },
            {
              questionId: 'Q-CON-04',
              questionNumber: 2,
              question: 'Does the courier consistently deliver our goods to our customers on the agreed date or period?',
              questionCategory: 'Delivery',
              section: 'SECTION 2: Reliability/Delivery (30 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 15, allowNa: true }
            },
            {
              questionId: 'Q-CON-05',
              questionNumber: 5,
              question: 'Does the courier service maintain a consistent level of acceptable service over time?',
              questionCategory: 'Delivery',
              section: 'SECTION 2: Reliability/Delivery (30 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 15, allowNa: true }
            },
            {
              questionId: 'Q-CON-06',
              questionNumber: 6,
              question: 'Please provide any additional comments on Reliability and Delivery performance.',
              questionCategory: 'Delivery',
              section: 'SECTION 2: Reliability/Delivery (30 points)',
              inputType: 'text' as const
            },
            {
              questionId: 'Q-CON-07',
              questionNumber: 7,
              question: "Are the courier's rates competitive and transparent?",
              questionCategory: 'Commercial',
              section: 'SECTION 3: Cost (20 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 7, allowNa: true }
            },
            {
              questionId: 'Q-CON-08',
              questionNumber: 8,
              question: 'Are there any hidden fees or surcharges?',
              questionCategory: 'Commercial',
              section: 'SECTION 3: Cost (20 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 7, allowNa: true }
            },
            {
              questionId: 'Q-CON-09',
              questionNumber: 9,
              question: 'Are they offering flexible payment options, e.g., credit cards or invoicing, and payment credit line?',
              questionCategory: 'Commercial',
              section: 'SECTION 3: Cost (20 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 6, allowNa: true }
            },
            {
              questionId: 'Q-CON-10',
              questionNumber: 10,
              question: 'Please provide any additional comments on Cost and pricing.',
              questionCategory: 'Commercial',
              section: 'SECTION 3: Cost (20 points)',
              inputType: 'text' as const
            },
            {
              questionId: 'Q-CON-11',
              questionNumber: 11,
              question: 'Do they have advanced tracking systems allowing customers for real-time monitoring of the status and location of their packages?',
              questionCategory: 'Technology',
              section: 'SECTION 4: Technology (10 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 5, allowNa: true }
            },
            {
              questionId: 'Q-CON-12',
              questionNumber: 12,
              question: 'Do they have online platforms and mobile apps provided to customers to schedule pickups, make payments, and arrange deliveries?',
              questionCategory: 'Technology',
              section: 'SECTION 4: Technology (10 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 5, allowNa: true }
            },
            {
              questionId: 'Q-CON-13',
              questionNumber: 13,
              question: 'Please provide any additional comments on Technology and online tools.',
              questionCategory: 'Technology',
              section: 'SECTION 4: Technology (10 points)',
              inputType: 'text' as const
            },
            {
              questionId: 'Q-CON-14',
              questionNumber: 14,
              question: 'Do they have a helpful and responsive customer support team?',
              questionCategory: 'Support',
              section: 'SECTION 5: Customer Service (25 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 10, allowNa: true }
            },
            {
              questionId: 'Q-CON-15',
              questionNumber: 15,
              question: "Do they effectively handle the customer's issues, and complaints, e.g., lost shipment, item, defective items?",
              questionCategory: 'Support',
              section: 'SECTION 5: Customer Service (25 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 10, allowNa: true }
            },
            {
              questionId: 'Q-CON-16',
              questionNumber: 16,
              question: 'Does the courier have a prompt payment process in case of mishandled goods, e.g., broken or missing goods?',
              questionCategory: 'Support',
              section: 'SECTION 5: Customer Service (25 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 5, allowNa: true }
            },
            {
              questionId: 'Q-CON-17',
              questionNumber: 17,
              question: 'Please provide any additional comments on Customer Service and support.',
              questionCategory: 'Support',
              section: 'SECTION 5: Customer Service (25 points)',
              inputType: 'text' as const
            },
            {
              questionId: 'Q-CON-18',
              questionNumber: 18,
              question: 'Do they ensure the safety and security of our packages/parcels during transit and delivery to the client\'s site?',
              questionCategory: 'Security',
              section: 'SECTION 6: Security (15 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 5, allowNa: true }
            },
            {
              questionId: 'Q-CON-19',
              questionNumber: 19,
              question: 'Do they include insurance options to cover potential loss or damage to our items?',
              questionCategory: 'Security',
              section: 'SECTION 6: Security (15 points)',
              inputType: 'typed-rating' as const,
              validationRange: { min: 0, max: 10, allowNa: true }
            },
            {
              questionId: 'Q-CON-20',
              questionNumber: 20,
              question: 'Please provide any additional comments on Security and safety.',
              questionCategory: 'Security',
              section: 'SECTION 6: Security (15 points)',
              inputType: 'text' as const
            }
          ];
          const supplierQuestions = [
  {
    "questionId": "Q-SUP-03",
    "questionNumber": 1,
    "question": "Period Covered",
    "questionCategory": "General",
    "section": "SECTION 1",
    "inputType": "select",
    "options": [
      "1st Half",
      "2nd Half",
      "Annual"
    ]
  },
  {
    "questionId": "Q-SUP-05",
    "questionNumber": 2,
    "question": "Does the supplier use the correct documents to facilitate the delivery of sale transaction? (BIR Registered, DR, SI/BS, OR/CR)",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 4,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-06",
    "questionNumber": 3,
    "question": "Are the required documents complete for every transaction?",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 4,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-07",
    "questionNumber": 4,
    "question": "Are documents clean, neat and readable?",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 4,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-08",
    "questionNumber": 5,
    "question": "Are documents presented/submitted upon delivery?",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 4,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-09",
    "questionNumber": 6,
    "question": "Are documents presented/submitted upon payments?",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 4,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-10",
    "questionNumber": 7,
    "question": "Documentation Remarks",
    "questionCategory": "Documentation",
    "section": "Documentation (20 points)",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUP-11",
    "questionNumber": 8,
    "question": "Does the supplier deliver the product on time based on the agreed schedule?",
    "questionCategory": "Delivery",
    "section": "Delivery (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-12",
    "questionNumber": 9,
    "question": "Does the supplier deliver the product in proper packaging and in good condition?",
    "questionCategory": "Delivery",
    "section": "Delivery (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-13",
    "questionNumber": 10,
    "question": "Does the supplier deliver the products sealed and safe and free for possible contamination?",
    "questionCategory": "Delivery",
    "section": "Delivery (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 6,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-14",
    "questionNumber": 11,
    "question": "Delivery Remarks",
    "questionCategory": "Delivery",
    "section": "Delivery (20 points)",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUP-15",
    "questionNumber": 12,
    "question": "Does the supplier change the price without any notice to MBS Procurement/BSM?",
    "questionCategory": "Price",
    "section": "Price/Cost Effectiveness (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 6,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-16",
    "questionNumber": 13,
    "question": "Is the supplier open for negotiation in terms of price?",
    "questionCategory": "Price",
    "section": "Price/Cost Effectiveness (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-17",
    "questionNumber": 14,
    "question": "Is the supplier pricing competitive with other suppliers?",
    "questionCategory": "Price",
    "section": "Price/Cost Effectiveness (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-18",
    "questionNumber": 15,
    "question": "Price/Cost Effectiveness Remarks",
    "questionCategory": "Price",
    "section": "Price/Cost Effectiveness (20 points)",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUP-19",
    "questionNumber": 16,
    "question": "Does the supplier deliver the product with good quality?",
    "questionCategory": "Quality",
    "section": "Quality (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-20",
    "questionNumber": 17,
    "question": "Does the supplier take immediate action for defective product upon delivery/RMA?",
    "questionCategory": "Quality",
    "section": "Quality (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 6,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-21",
    "questionNumber": 18,
    "question": "Does the supplier replace the defective product immediately?",
    "questionCategory": "Quality",
    "section": "Quality (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-22",
    "questionNumber": 19,
    "question": "Quality Remarks",
    "questionCategory": "Quality",
    "section": "Quality (20 points)",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUP-23",
    "questionNumber": 20,
    "question": "Do supplier responsive and easy to contact?",
    "questionCategory": "Communication",
    "section": "Communication (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-24",
    "questionNumber": 21,
    "question": "Does the supplier proactively communicate to MBS Representatives in terms of any discrepancy or changes in transaction?",
    "questionCategory": "Communication",
    "section": "Communication (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 6,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-25",
    "questionNumber": 22,
    "question": "Does the supplier proactively communicate to MBS Representatives fact-based concern on product/technology?",
    "questionCategory": "Communication",
    "section": "Communication (20 points)",
    "inputType": "typed-rating",
    "validationRange": {
      "min": 0,
      "max": 7,
      "allowNa": true
    }
  },
  {
    "questionId": "Q-SUP-26",
    "questionNumber": 23,
    "question": "Communication Remarks",
    "questionCategory": "Communication",
    "section": "Communication (20 points)",
    "inputType": "text"
  }
];
          const subcontractorQuestions = [
  {
    "questionId": "Q-SUB-01",
    "questionNumber": 1,
    "question": "Project Name",
    "questionCategory": "General",
    "section": "SECTION 1",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUB-02",
    "questionNumber": 2,
    "question": "Products or Services",
    "questionCategory": "General",
    "section": "SECTION 1",
    "inputType": "checkbox",
    "options": [
      "Access Control System",
      "CCTV System",
      "Civil Works",
      "Electrical Works",
      "Fire Suppression System",
      "Mechanical Works",
      "Structured Cabling System",
      "Others"
    ]
  },
  {
    "questionId": "Q-SUB-03",
    "questionNumber": 3,
    "question": "Project Duration",
    "questionCategory": "General",
    "section": "SECTION 1",
    "inputType": "date-range"
  },
  {
    "questionId": "Q-SUB-04",
    "questionNumber": 4,
    "question": "Delivery / Project Timeliness",
    "questionCategory": "Delivery",
    "section": "SECTION 4",
    "inputType": "matrix",
    "subQuestions": [
      {
        "id": "a",
        "label": "Except for circumstances beyond the subcontractor's control, tasks and deliverables were completed on time or ahead of the schedule in the contact.",
        "description": "Always = 2, <2wks late = 1, >2wks late = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "b",
        "label": "Delivers and use all resources required to the project and turnover all excess materials to MBS Project Manager.",
        "description": "Consistently = 2, Inconsistent = 1, Not at all = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      }
    ]
  },
  {
    "questionId": "Q-SUB-05",
    "questionNumber": 5,
    "question": "Delivery / Project Timeliness Remarks",
    "questionCategory": "Delivery",
    "section": "SECTION 4",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUB-06",
    "questionNumber": 6,
    "question": "Documentation / Invoicing",
    "questionCategory": "Documentation",
    "section": "SECTION 5",
    "inputType": "matrix",
    "subQuestions": [
      {
        "id": "a",
        "label": "The subcontractor's invoices/billing were correct, accurate and contained all information of references.",
        "description": "Always = 2, Limited correction/tolerable = 1, Multiple important corrections/delays = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "b",
        "label": "All required documents are submitted on time or within the time frames of agreement e.g. Service report, billing, COC, etc.",
        "description": "Very timely = 2, <1 week = 1, >1 week = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "c",
        "label": "The proposal provides a clear breakdown matched with what MBS requires.",
        "description": "Consistently = 2, Scope inaccurate but no price increase = 1, Incomplete/leads to price increase = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      }
    ]
  },
  {
    "questionId": "Q-SUB-07",
    "questionNumber": 7,
    "question": "Documentation / Invoicing Remarks",
    "questionCategory": "Documentation",
    "section": "SECTION 5",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUB-08",
    "questionNumber": 8,
    "question": "Cost Control / Pricing",
    "questionCategory": "Cost",
    "section": "SECTION 6",
    "inputType": "matrix",
    "subQuestions": [
      {
        "id": "a",
        "label": "Give competitive prices, discount, and reasonable prices.",
        "description": "Yes/accommodate within MBS budget = 2, No = 1, (unused) = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "b",
        "label": "Request for change of orders for additional works/cost ONLY outside the scope of contract.",
        "description": "Yes = 2, Seldom requests = 1, Does not accommodate = 0",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "c",
        "label": "Indication that the subcontractor has financial problem which cannot meet the terms and conditions stated in contract.",
        "description": "Healthy financial position = 2, Liquid for at least <1M = 1, Always needs fund to mobilize project = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      }
    ]
  },
  {
    "questionId": "Q-SUB-09",
    "questionNumber": 9,
    "question": "Cost Control / Pricing Remarks",
    "questionCategory": "Cost",
    "section": "SECTION 6",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUB-10",
    "questionNumber": 10,
    "question": "Quality and Technical Competence",
    "questionCategory": "Quality",
    "section": "SECTION 7",
    "inputType": "matrix",
    "subQuestions": [
      {
        "id": "a",
        "label": "The Subcontractor work products complied with the contract, PO scope of work, rules and applicable program guidance.",
        "description": "Consistently met, no re-work = 2, Mostly met/minor re-work = 1, Substandard = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "b",
        "label": "The subcontractor performed site assessment tasks efficiently and effectively, proposed cost-effective changes in scope, provided an accurate summary and proposed cost-effective recommendations for future work and course of action.",
        "description": "Consistently = 2, Minor ineffective/inaccurate summary = 1, Summaries had to be re-worked = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "c",
        "label": "The subcontractor proposed appropriate changes to monitoring points, parameters, and or frequency based on changing site conditions.",
        "description": "Consistently = 2, Minor changes not proposed = 1, Changes not proposed though warranted = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "d",
        "label": "The remedial action plan adequately and cost-effectively addressed the site conditions.",
        "description": "Always = 2, Minor inconsistent guidelines = 1, Remedial action had to be reworked = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "e",
        "label": "The subcontractor initiates Certificate of Completion when the project has been done.",
        "description": "Yes = 2, Only when prompted by MBS accounting/PM = 1, Not at all = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      }
    ]
  },
  {
    "questionId": "Q-SUB-11",
    "questionNumber": 11,
    "question": "Quality and Technical Competence Remarks",
    "questionCategory": "Quality",
    "section": "SECTION 7",
    "inputType": "text"
  },
  {
    "questionId": "Q-SUB-12",
    "questionNumber": 12,
    "question": "Communication",
    "questionCategory": "Communication",
    "section": "SECTION 8",
    "inputType": "matrix",
    "subQuestions": [
      {
        "id": "a",
        "label": "The subcontractor communicated and proposed solutions of project changes, problems, delays and issues to MBS representative as they occurred and ahead of deadlines.",
        "description": "Always = 2, Some untimely/less helpful = 1, Problems from untimely/poor comms = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "b",
        "label": "The subcontractor responded within a reasonable time frame to telephone messages and emails from MBS representative.",
        "description": "Within 2 business days = 2, Within 3-5 days = 1, More than 5 days = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      },
      {
        "id": "c",
        "label": "The subcontractor is professional in their approach, provide assistance whenever needed, courteous and polite.",
        "description": "Always regardless of who = 2, Depends on position = 1, Unprofessional at all times = 0, Not Applicable = N/A",
        "validationRange": {
          "min": 0,
          "max": 2,
          "allowNa": true
        }
      }
    ]
  },
  {
    "questionId": "Q-SUB-13",
    "questionNumber": 13,
    "question": "Communication Remarks",
    "questionCategory": "Communication",
    "section": "SECTION 8",
    "inputType": "text"
  }
];

          loadedSurveys = [
            {
              id: 'default-courier',
              title: 'Courier Satisfaction Survey',
              surveyType: 'Courier',
              description: 'Standard satisfaction reporting for external courier and logistics.',
              createdAt: new Date('2025-01-01T08:00:00Z').toISOString(),
              deadlineDate: '31/12/2026',
              // Migrated system: prior evaluation rounds were run in the old
              // system, so every survey starts CLOSED here. Admins reopen (set
              // to Running) when a new evaluation period begins.
              status: 'Completed',
              accessDepartments: ALL_DEPARTMENTS,
              accessRoles: [...ALL_SURVEY_ACCESS_ROLES],
              questions: contractorQuestions as any,
            },
            {
              id: 'default-supplier',
              title: 'Supplier Quality Survey',
              surveyType: 'Supplier',
              description: 'Product quality and commercial terms assessment for inventory suppliers.',
              createdAt: new Date('2025-01-01T08:00:00Z').toISOString(),
              deadlineDate: '31/12/2026',
              status: 'Completed',
              accessDepartments: ALL_DEPARTMENTS,
              accessRoles: [...ALL_SURVEY_ACCESS_ROLES],
              questions: supplierQuestions as any,
            },
            {
              id: 'default-subcontractor',
              title: 'Subcontractor Performance Survey',
              surveyType: 'Subcontractor',
              description: 'On-site execution, compliance, and schedule feedback for active subcontractors.',
              createdAt: new Date('2025-01-01T08:00:00Z').toISOString(),
              deadlineDate: '31/12/2026',
              status: 'Completed',
              accessDepartments: ALL_DEPARTMENTS,
              accessRoles: [...ALL_SURVEY_ACCESS_ROLES],
              questions: subcontractorQuestions as any,
            },
          ];
          // Run default surveys through the same normalization as saved ones,
          // so they also get the "Overall Comments & Feedback" question
          // injected (ensureOverallFeedbackQuestion). Without this, a fresh
          // install's default question sets have no such question at all,
          // so simulated responses can never produce a stakeholder comment
          // for any company using an untouched default survey.
          loadedSurveys = loadedSurveys.map(normalizeCustomForm);
          localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(loadedSurveys));
        }

        // 2. Handle Partner Companies
        let loadedCompanies: PartnerCompany[] = [];
        try {
          if (!isSupabaseConfigured) {
            throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
          }
          loadedCompanies = (await fetchPartnerCompanies()).map(normalizePartnerCompany);
        } catch (companyLoadError) {
          loadErrorMessage = companyLoadError instanceof Error ? companyLoadError.message : 'Unable to load partner companies from Supabase.';
          loadedCompanies = [];
        }

        // 3. Handle Responses from Supabase
        let loadedResponses: SurveyResponse[] = [];
        try {
          if (!isSupabaseConfigured) {
            throw new Error('Supabase is not configured.');
          }
          const supabaseResponses = await fetchSurveyResponses();
          loadedResponses = supabaseResponses.map(normalizeSurveyResponse);
          safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(loadedResponses)));
        } catch (responseLoadError) {
          console.warn('Failed to load responses from Supabase:', responseLoadError instanceof Error ? responseLoadError.message : String(responseLoadError));
          // Fall back to localStorage if Supabase fails
          if (localStorage.getItem('survey_analytics_v6_cleared_by_agent_final') !== 'true') {
            localStorage.removeItem('survey_analytics_responses');
            localStorage.removeItem('survey_analytics_responses_v4');
            localStorage.removeItem('survey_analytics_responses_v5');
            localStorage.removeItem('survey_analytics_responses_v6');
            localStorage.removeItem('survey_analytics_full_dataset_active');
            localStorage.setItem('survey_analytics_v6_cleared_by_agent_final', 'true');
          }

          const savedResponses = localStorage.getItem('survey_analytics_responses_v6');
          let parsedResponses: any[] = [];
          try {
            parsedResponses = savedResponses ? JSON.parse(savedResponses) : [];
          } catch (e) {}

          if (savedResponses && parsedResponses.length > 0) {
            loadedResponses = decompressResponses(parsedResponses).map(normalizeSurveyResponse);
            safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(loadedResponses)));
          } else {
            loadedResponses = [];
            safeSetItem('survey_analytics_responses_v6', JSON.stringify([]));
          }
        }

        if (isMountedRef.current) {
          setSurveys(loadedSurveys);
          setPartnerCompanies(loadedCompanies);
          setResponses(loadedResponses);

          const groupedNotifs = groupResponsesToNotifications(loadedResponses);
          setNotifications(groupedNotifs.slice(0, INITIAL_NOTIFICATION_SEED));
        }
        if (loadErrorMessage && isMountedRef.current) {
          setError(loadErrorMessage);
        }
      } catch (loadError) {
        if (isMountedRef.current) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load survey data.');
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    }

    void initData();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Create a new survey form
  const createSurvey = (newForm: Omit<CustomForm, 'id' | 'createdAt'>) => {
    const id = `survey-${Date.now()}`;
    const createdAt = new Date().toISOString();
    const surveyWithId: CustomForm = {
      ...normalizeCustomForm(newForm as CustomForm),
      id,
      createdAt,
    };

    const updatedSurveys = [surveyWithId, ...surveys];
    setSurveys(updatedSurveys);
    localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(updatedSurveys));
    return surveyWithId;
  };

  // Update an existing survey form
  const updateSurvey = (updatedForm: CustomForm) => {
    const normalizedForm = normalizeCustomForm(updatedForm);
    setSurveys((currentSurveys) => {
      const updated = currentSurveys.map((s) => s.id === normalizedForm.id ? normalizedForm : s);
      localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(updated));
      return updated;
    });
    return normalizedForm;
  };

  // Bulk update multiple survey forms simultaneously to prevent React state batching overwrites
  const updateSurveysBulk = (updatedSurveysList: CustomForm[]) => {
    const map = new Map(updatedSurveysList.map((s) => [s.id, normalizeCustomForm(s)]));
    setSurveys((currentSurveys) => {
      const updated = currentSurveys.map((s) => map.has(s.id) ? map.get(s.id)! : s);
      localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(updated));
      return updated;
    });
  };

  // Renames one of a survey type's 5 categories (Categories Manager). Every
  // question across every survey of that type - and every already-submitted
  // response's stored questionCategory, active or archived - that carries
  // the old label is rewritten to the new one in the same pass, so the
  // rename is immediately visible everywhere that groups by questionCategory
  // (bar charts, N/A frequency, reports) without leaving old-label data
  // behind as an orphaned bucket. The radar chart (which groups by
  // questionWeights.ts's own section labels, not questionCategory) picks up
  // the rename separately via getLiveCategoryLabel, which reads the same
  // categoryLabels storage this function writes to.
  const renameCategory = (surveyType: SurveyType, slotIndex: number, newLabel: string) => {
    const trimmed = newLabel.trim();
    const oldLabel = categoryLabels[surveyType][slotIndex];
    if (!trimmed || trimmed === oldLabel) return;

    setCategoryLabels((current) => {
      const updated = { ...current, [surveyType]: current[surveyType].map((label, i) => (i === slotIndex ? trimmed : label)) };
      localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });

    setSurveys((currentSurveys) => {
      const updated = currentSurveys.map((s) => {
        if (s.surveyType !== surveyType) return s;
        if (!s.questions.some((q) => q.questionCategory === oldLabel)) return s;
        return { ...s, questions: s.questions.map((q) => (q.questionCategory === oldLabel ? { ...q, questionCategory: trimmed } : q)) };
      });
      localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(updated));
      return updated;
    });

    setResponses((currentResponses) => {
      const updated = currentResponses.map((r) =>
        r.surveyType === surveyType && r.questionCategory === oldLabel ? { ...r, questionCategory: trimmed } : r
      );
      safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updated)));
      return updated;
    });
  };

  // Restores all 5 categories of one survey type to their factory defaults
  // in one pass (Categories Manager's "Restore to Default").
  const restoreDefaultCategories = (surveyType: SurveyType) => {
    DEFAULT_CATEGORIES[surveyType].forEach((defaultLabel, slotIndex) => {
      if (categoryLabels[surveyType][slotIndex] !== defaultLabel) {
        renameCategory(surveyType, slotIndex, defaultLabel);
      }
    });
  };

  // Delete a survey form
  const deleteSurvey = (surveyId: string) => {
    const updatedSurveys = surveys.filter((s) => s.id !== surveyId);
    setSurveys(updatedSurveys);
    localStorage.setItem('survey_analytics_surveys_v6', JSON.stringify(updatedSurveys));

    // Also optionally clean up custom responses submitted specifically to this survey?
    // Let's filter out responses that match the deleted survey's questions and aren't default ones.
    // However, to be safe, let's keep responses unless specifically wanted, or just clean them up.
    // Actually, cleaning them up keeps analytics clean! Let's do it if we want, or keep it simple.
  };

  // Submit a survey response
  const submitResponse = (
    surveyId: string,
    company: string,
    department: string,
    respondentType: string,
    address: string | undefined,
    answers: { questionId: string; questionNumber: number; question: string; questionCategory: string; rating: Rating; comment: string }[],
    respondentEmail?: string,
    startTime?: string
  ) => {
    const targetSurvey = surveys.find((s) => s.id === surveyId);
    if (!targetSurvey) return null;

    const responseId = `RESP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const submissionDate = new Date().toISOString();

    const newResponses: SurveyResponse[] = answers.map((ans) => ({
      responseId,
      surveyType: targetSurvey.surveyType,
      respondentType,
      startTime,
      submissionDate,
      company,
      department,
      address,
      questionId: ans.questionId,
      questionNumber: ans.questionNumber,
      question: ans.question,
      questionCategory: ans.questionCategory,
      rating: ans.rating,
      comment: ans.comment || 'Submitted successfully.',
      respondentEmail,
    }));

    const updatedResponses = [...responses, ...newResponses];
    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));

    // Best-effort mirror to Supabase - localStorage above remains the source
    // of truth the rest of the app reads from until the read side is
    // migrated too (see supabase/schema.sql).
    insertSurveyResponses(newResponses);

    // Add notification
    const notification = toNotification(newResponses);
    if (notification) {
      setNotifications((current) => [notification, ...current].slice(0, NOTIFICATION_HISTORY_LIMIT));
      setUnreadCount((count) => count + 1);
    }

    return responseId;
  };

  // Create or add a partner company
  const addPartnerCompany = (
    name: string,
    type: SurveyType,
    affiliation?: string,
    registeredAt?: string,
    bpCode?: string,
    ntBpCode?: string,
    supplierOrigin?: SupplierOrigin
  ) => {
    const todayStr = getEffectiveTodayStr(simClock);
    const id = `pc-${Date.now()}`;
    // Mirrors the Master List's own category string (e.g. "Supplier-Local",
    // "Courier-NT") so a manually-registered company is picked up by
    // computeCategoryRankSummary the same way an imported row is - that
    // summary reads branch.rawCategory, not company.type/supplierOrigin.
    const rawCategoryBase = type === 'Supplier' ? `Supplier-${supplierOrigin === 'Foreign' ? 'Foreign' : 'Local'}` : type;
    // A second, Non-Trade BP Code registers as its own branch (mirrors how a
    // Master List row with a "-NT" BP Code merges in) so it shows up as its
    // own row in the Document Tracker, distinct from the regular branch.
    const branches: BranchRecord[] = [{ id: `${id}-branch-1`, bpCode: (bpCode ?? '').trim(), rawCategory: rawCategoryBase }];
    if (ntBpCode?.trim()) {
      branches.push({ id: `${id}-branch-2`, bpCode: ntBpCode.trim(), rawCategory: `${rawCategoryBase}-NT` });
    }
    const newCompany: PartnerCompany = normalizePartnerCompany({
      id,
      name: name.trim(),
      type,
      supplierOrigin: type === 'Supplier' ? (supplierOrigin ?? 'Local') : undefined,
      affiliation: affiliation?.trim() || 'General partner',
      createdAt: new Date().toISOString(),
      registeredAt: registeredAt || todayStr,
      isArchived: false,
      branches,
    });
    const updated = [...partnerCompanies, newCompany];
    setPartnerCompanies(updated);
    void syncPartnerCompanies([newCompany]).catch((error) => {
      console.error('Supabase: failed to save partner company', error);
    });
    return newCompany;
  };

  // Update an existing partner company
  const updatePartnerCompany = (updatedCompany: PartnerCompany) => {
    const normalizedCompany = normalizePartnerCompany(updatedCompany);
    setPartnerCompanies((currentCompanies) => {
      const updated = currentCompanies.map((c) => c.id === normalizedCompany.id ? normalizedCompany : c);
      void syncPartnerCompanies([normalizedCompany]).catch((error) => {
        console.error('Supabase: failed to update partner company', error);
      });
      return updated;
    });
    return normalizedCompany;
  };

  // Update several partner companies in one state update/localStorage write
  // (e.g. Supplier Ranking's drag-reorder, which can touch up to 20 rows at
  // once) instead of one updatePartnerCompany call per row. Mirrors
  // updateSurveysBulk's identical rationale/pattern above.
  const updatePartnerCompaniesBulk = (updatedCompaniesList: PartnerCompany[]) => {
    const map = new Map(updatedCompaniesList.map((c) => [c.id, normalizePartnerCompany(c)]));
    setPartnerCompanies((currentCompanies) => {
      const updated = currentCompanies.map((c) => map.has(c.id) ? map.get(c.id)! : c);
      void syncPartnerCompanies([...map.values()]).catch((error) => {
        console.error('Supabase: failed to update partner companies', error);
      });
      return updated;
    });
  };

  // Import the Master List Excel: fuzzy-matches each row's BP Name against
  // existing companies (merging as a branch when matched, creating a new
  // company otherwise). This only parses/merges and returns the result for
  // review - nothing is saved until the caller confirms via
  // commitMasterListImport, so the admin can see exactly which existing
  // companies would change (category, documents) before anything is
  // overwritten.
  const previewMasterListImport = async (file: File, options?: { replace?: boolean }): Promise<ImportResult> => {
    // Replace mode starts from an empty registry so the result mirrors the file
    // exactly (its category/rank totals match the sheet), instead of merging
    // the file's rows on top of whatever is already loaded.
    const base = options?.replace ? [] : partnerCompanies;
    return importMasterListFromFile(file, base);
  };

  // Applies a previously-previewed import result to the live registry.
  const commitMasterListImport = (result: ImportResult) => {
    const normalized = result.companies.map(normalizePartnerCompany);
    setPartnerCompanies(normalized);
    void replacePartnerCompanies(normalized).catch((error) => {
      console.error('Supabase: failed to replace partner companies', error);
    });
  };

  // Remove a partner company
  const removePartnerCompany = (id: string) => {
    const updated = partnerCompanies.filter((c) => c.id !== id);
    setPartnerCompanies(updated);
    void deletePartnerCompanyFromSupabase(id).catch((error) => {
      console.error('Supabase: failed to delete partner company', error);
    });
  };

  // Reset to initial mock data state
  const resetAllData = () => {
    localStorage.removeItem('survey_analytics_surveys');
    localStorage.removeItem('survey_analytics_surveys_v4');
    localStorage.removeItem('survey_analytics_surveys_v5');
    localStorage.removeItem('survey_analytics_surveys_v6');
    localStorage.removeItem('survey_analytics_responses');
    localStorage.removeItem('survey_analytics_responses_v4');
    localStorage.removeItem('survey_analytics_responses_v5');
    localStorage.removeItem('survey_analytics_responses_v6');
    localStorage.removeItem('survey_analytics_partner_companies_v4');
    localStorage.removeItem('survey_analytics_partner_companies_v5');
    localStorage.removeItem('survey_analytics_partner_companies_v6');
    localStorage.removeItem('survey_analytics_partner_companies_v7');
    localStorage.removeItem('survey_analytics_full_dataset_active');
    localStorage.removeItem(CATEGORIES_STORAGE_KEY);
    window.location.reload();
  };

  // Every non-admin account currently registered in the system becomes part
  // of the synthetic respondent pool used by the Database Simulator. This
  // means the pool automatically grows or shrinks as accounts are added or
  // removed in Account Management — no hardcoded headcount to maintain.
  const NON_ADMIN_USERS = useMemo(() => {
    const derived = accounts
      .filter((a) => a.role !== 'Admin')
      .map((a) => ({ rType: a.designation, dept: a.department, email: a.email }));
    return derived.length > 0 ? derived : FALLBACK_NON_ADMIN_USERS;
  }, [accounts]);

  const BULK_BATCH_SIZE = 15;

  // Single unified entry point for the admin "Add Evaluation" test tool.
  // - single: adds one random evaluation on top of whatever already exists.
  // - bulk: adds a batch of random evaluations on top of whatever already exists.
  // - complete: replaces all responses with a fully-covered dataset where every
  //   non-admin employee has evaluated every registered company.
  const addEvaluations = (mode: 'single' | 'bulk' | 'complete') => {
    const targetDate = getEffectiveNow(simClock);
    if (mode === 'complete') {
      const fullRows = generateAllMockResponses(surveys, partnerCompanies, NON_ADMIN_USERS, targetDate);
      // Only the active period gets replaced - previously archived rows
      // (e.g. an archived prior year) must survive re-simulating a fresh
      // "complete" dataset, otherwise archiving followed by re-simulating
      // silently erases that archived history.
      const preservedArchived = responses.filter((r) => r.archived);
      const updated = [...preservedArchived, ...fullRows];
      setResponses(updated);
      safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updated)));

      const groupedNotifs = groupResponsesToNotifications(fullRows);
      setNotifications(groupedNotifs.slice(0, NOTIFICATION_HISTORY_LIMIT));
      setUnreadCount(0);
      setIsFullDatasetActive(true);
      safeSetItem('survey_analytics_full_dataset_active', 'true');
      return;
    }

    const newRows =
      mode === 'bulk'
        ? generateBulkMockResponses(BULK_BATCH_SIZE, surveys, partnerCompanies, NON_ADMIN_USERS, targetDate)
        : generateSingleMockResponse(surveys, partnerCompanies, NON_ADMIN_USERS, targetDate);

    if (newRows.length === 0) return;

    const updated = [...responses, ...newRows];
    setResponses(updated);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updated)));
    setIsFullDatasetActive(false);
    safeSetItem('survey_analytics_full_dataset_active', 'false');

    const newNotifications = groupResponsesToNotifications(newRows);
    if (newNotifications.length > 0) {
      setNotifications((current) => [...newNotifications, ...current].slice(0, NOTIFICATION_HISTORY_LIMIT));
      setUnreadCount((count) => count + newNotifications.length);
    }
  };

  const clearResponses = () => {
    setResponses([]);
    setNotifications([]);
    setUnreadCount(0);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify([]));
    setIsFullDatasetActive(false);
    safeSetItem('survey_analytics_full_dataset_active', 'false');
    window.location.reload();
  };

  const resetSimulation = () => {
    const isSimulated = (id: string) => 
      id.startsWith('RESP-MOCK-') || 
      id.startsWith('RESP-SINGLE-') || 
      id.startsWith('RESP-BULK-');
      
    const filtered = responses.filter(r => !isSimulated(r.responseId));
    setResponses(filtered);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(filtered)));
    setIsFullDatasetActive(false);
    safeSetItem('survey_analytics_full_dataset_active', 'false');

    const remainingSimulated = filtered.filter(r => isSimulated(r.responseId));
    const groupedNotifs = groupResponsesToNotifications(filtered);
    setNotifications(groupedNotifs.slice(0, NOTIFICATION_HISTORY_LIMIT));
    setUnreadCount(0);
  };

  const markNotificationsRead = () => {
    setUnreadCount(0);
  };

  // Split active and archived responses so the active dashboard is unaffected
  const activeResponses = useMemo(() => {
    return responses.filter(r => !r.archived);
  }, [responses]);

  const archivedResponses = useMemo(() => {
    return responses.filter(r => r.archived);
  }, [responses]);

  const archiveResponsesForSurveys = (surveyIds: string[], seriesLabel?: string) => {
    const targetSurveys = surveys.filter(s => surveyIds.includes(s.id));
    const questionIdsToArchive = new Map<string, { id: string; title: string }>();
    const archiveDate = new Date().toISOString();
    const seriesId = seriesLabel && seriesLabel.trim() ? getOrCreateSeries(seriesLabel) : undefined;

    targetSurveys.forEach(s => {
      s.questions.forEach(q => {
        questionIdsToArchive.set(q.questionId, { id: s.id, title: s.title });
        if (q.subQuestions) {
          q.subQuestions.forEach(sub => questionIdsToArchive.set(`${q.questionId}-${sub.id}`, { id: s.id, title: s.title }));
        }
      });
    });

    const updatedResponses = responses.map(r => {
      const surveyInfo = questionIdsToArchive.get(r.questionId);
      if (surveyInfo) {
        return {
          ...r,
          archived: true,
          archivedAt: archiveDate,
          archivedBySurveyId: surveyInfo.id,
          archivedBySurveyTitle: surveyInfo.title,
          ...(seriesId ? { seriesId } : {}),
        };
      }
      return r;
    });

    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
  };

  const restoreResponseGroup = (responseId: string) => {
    const updatedResponses = responses.map(r => {
      if (r.responseId === responseId) {
        return { ...r, archived: false };
      }
      return r;
    });

    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
  };

  const restoreResponsesForSurvey = (surveyId: string) => {
    const targetSurvey = surveys.find(s => s.id === surveyId);
    if (!targetSurvey) return;
    const questionIdsToRestore = new Set<string>();
    targetSurvey.questions.forEach(q => {
      questionIdsToRestore.add(q.questionId);
      if (q.subQuestions) {
        q.subQuestions.forEach(sub => questionIdsToRestore.add(`${q.questionId}-${sub.id}`));
      }
    });

    const updatedResponses = responses.map(r => {
      if (questionIdsToRestore.has(r.questionId)) {
        return { ...r, archived: false };
      }
      return r;
    });

    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
  };

  const deleteArchivedResponseGroups = (groupIds: { archivedAt: string; surveyId: string }[]) => {
    const updatedResponses = responses.filter(r => {
      if (!r.archived || !r.archivedAt || !r.archivedBySurveyId) return true;
      const match = groupIds.some(g => g.archivedAt === r.archivedAt && g.surveyId === r.archivedBySurveyId);
      return !match;
    });
    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
  };

  const restoreArchivedResponseGroups = (groupIds: { archivedAt: string; surveyId: string }[]) => {
    const updatedResponses = responses.map(r => {
      if (!r.archived || !r.archivedAt || !r.archivedBySurveyId) return r;
      const match = groupIds.some(g => g.archivedAt === r.archivedAt && g.surveyId === r.archivedBySurveyId);
      if (match) {
        return { ...r, archived: false };
      }
      return r;
    });
    setResponses(updatedResponses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
  };

  // Restores a previously-exported archived-response file (see
  // archiveResponseTransfer.ts). Every imported row is forced archived
  // regardless of what the file says, and duplicates (by responseId) are
  // skipped - see mergeImportedResponses for the exact rules.
  const importArchivedResponses = async (file: File): Promise<ArchiveImportResult> => {
    const result = await importArchivedResponsesFromFile(file, responses, getOrCreateSeries);
    setResponses(result.responses);
    safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(result.responses)));
    return result;
  };

  // Parses a raw Microsoft Forms export of one of the three official
  // evaluation forms (Supplier/Subcontractor/Courier) and resolves each row's
  // company name against the full Partner Registry (any type/archived state -
  // a perfect name match sitting there Uncategorized/archived is still the
  // same company, just misclassified). Nothing is committed yet - genuinely
  // unmatched companies are returned for the caller to decide skip/add-as-partner
  // via commitRawEvaluations.
  const previewRawEvaluations = async (file: File, surveyType: SurveyType): Promise<RawEvalPreview> => {
    const accountProfiles = accounts.map((a) => ({ email: a.email, designation: a.designation, department: a.department }));
    return previewRawEvaluationImportFile(file, surveyType, partnerCompanies, accountProfiles);
  };

  // Commits a previously-parsed import. Re-uploading the same file is safe:
  // each source row's own "ID" column becomes part of a deterministic
  // responseId (IMPORT-{TYPE}-{id}), so a re-run replaces those exact rows in
  // place instead of duplicating them. Companies the admin chose "add as
  // partner" for are created as minimal, unaccredited registry entries.
  const commitRawEvaluations = (preview: RawEvalPreview, decisions: Record<string, CompanyDecision>): RawEvalImportSummary => {
    const { responses: newRows, newPartnerCompanies, summary } = commitRawEvaluationImportRows(preview, decisions);

    const newIds = new Set(newRows.map((r) => r.responseId));
    const replaced = new Set(responses.filter((r) => newIds.has(r.responseId)).map((r) => r.responseId)).size;

    // Functional updates so concurrent imports (e.g. Supplier/Subcontractor/
    // Courier files staged and confirmed together) each apply on top of the
    // latest state instead of the stale `responses`/`partnerCompanies`
    // closure from whichever render kicked them off - otherwise the last
    // commit to resolve silently clobbers the others.
    setResponses((prevResponses) => {
      const untouched = prevResponses.filter((r) => !newIds.has(r.responseId));
      const updatedResponses = [...untouched, ...newRows];
      safeSetItem('survey_analytics_responses_v6', JSON.stringify(compressResponses(updatedResponses)));
      return updatedResponses;
    });

    if (newPartnerCompanies.length) {
      const normalizedNew = newPartnerCompanies.map(normalizePartnerCompany);
      setPartnerCompanies((prevCompanies) => {
        const updatedCompanies = [...prevCompanies, ...normalizedNew];
        void syncPartnerCompanies(normalizedNew).catch((error) => {
          console.error('Supabase: failed to add imported partner companies', error);
        });
        return updatedCompanies;
      });
    }

    const finalSummary: RawEvalImportSummary = { ...summary, replaced };
    logAdminActivity(
      `Imported ${preview.surveyType} evaluation responses`,
      `${summary.imported} submissions from "${preview.fileName}"${replaced ? ` (${replaced} replaced)` : ''}` +
        `${newPartnerCompanies.length ? `, ${newPartnerCompanies.length} new partner(s) added` : ''}`
    );
    return finalSummary;
  };

  // Derive unique active survey types (Courier, Supplier, Subcontractor)
  const surveyTypes = useMemo<SurveyType[]>(() => {
    return ['Courier', 'Supplier', 'Subcontractor'];
  }, []);

  // Derive list of all questions across all surveys
  const questions = useMemo<QuestionDefinition[]>(() => {
    // Generate standard definitions from currently loaded surveys
    const questionMap: Record<string, QuestionDefinition> = {};
    surveys.forEach((survey) => {
      survey.questions.forEach((q) => {
        if (!questionMap[q.questionId]) {
          questionMap[q.questionId] = {
            questionId: q.questionId,
            questionNumber: q.questionNumber,
            question: q.question,
            questionCategory: q.questionCategory,
            surveyTypes: [],
          };
        }
        if (!questionMap[q.questionId].surveyTypes.includes(survey.surveyType)) {
          questionMap[q.questionId].surveyTypes.push(survey.surveyType);
        }
      });
    });
    return Object.values(questionMap).sort((a, b) => a.questionNumber - b.questionNumber);
  }, [surveys]);

  const companies = useMemo(() => {
    return partnerCompanies.map((c) => c.name).sort();
  }, [partnerCompanies]);

  // Dynamic compliance-document warnings/expirations for admin notifications.
  // One notification per company (not per document) so this stays the same
  // shape/cardinality the old per-company contract alerts had - see
  // computeCompanyDocumentSummary for how "Expired" is rolled up across a
  // company's required documents (Business Permit, AFS, SIF, etc.).
  const documentNotifications = useMemo<ResponseNotification[]>(() => {
    const currentDate = getEffectiveNow(simClock);
    const list: ResponseNotification[] = [];

    partnerCompanies.forEach((c) => {
      if (c.isArchived) return;
      const summary = computeCompanyDocumentSummary(c, currentDate);

      if (summary.status === 'Expired') {
        list.push({
          id: `document-expired-${c.id}`,
          company: c.name,
          surveyType: c.type as SurveyType,
          respondentType: 'Document Expired',
          submissionDate: new Date(currentDate.getTime() - 12 * 60 * 60 * 1000).toISOString(),
          questionCount: summary.expiredCount,
          respondentEmail: 'system@mgenesis.com',
          department: 'Logistics',
          designation: 'Document Alert'
        });
      } else if (summary.status === 'Expiring Soon') {
        list.push({
          id: `document-warning-${c.id}`,
          company: c.name,
          surveyType: c.type as SurveyType,
          respondentType: 'Document Expiring Soon',
          submissionDate: new Date(currentDate.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          questionCount: summary.expiringSoonCount,
          respondentEmail: 'system@mgenesis.com',
          department: 'Logistics',
          designation: 'Document Alert'
        });
      }
    });

    return list;
  }, [partnerCompanies, simClock]);

  // Extra early heads-up notifications, per document type, configured via
  // the Document Register's "Add Notification" settings screen (see
  // src/utils/documentNotificationSettings.ts) - on top of the standard
  // 30-day "Expiring Soon" alert already covered by documentNotifications
  // above. Defaults to the client's DTI Registration requirement ("Notify
  // admin at 60-day and 30-day expiration milestones"): the 30-day one is
  // the standard alert every expiry doc already gets, this covers the extra
  // 60-day one. Admin can add early milestones for other documents too.
  const [notificationSettingsVersion, setNotificationSettingsVersion] = useState(0);
  useEffect(() => {
    const handler = () => setNotificationSettingsVersion((v) => v + 1);
    window.addEventListener(NOTIFICATION_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED_EVENT, handler);
  }, []);

  const earlyMilestoneNotifications = useMemo<ResponseNotification[]>(() => {
    const currentDate = getEffectiveNow(simClock);
    const list: ResponseNotification[] = [];
    const rules = getNotificationSettings().filter(
      (r) => r.enabled && r.mode === 'day-milestones' && r.earlyMilestoneDays.length > 0
    );
    if (rules.length === 0) return list;

    partnerCompanies.forEach((c) => {
      if (c.isArchived) return;
      const requiredKeys = getRequiredDocumentKeys(c.type, c.supplierOrigin);

      rules.forEach((rule) => {
        if (!requiredKeys.includes(rule.docName)) return;
        const doc = (c.branches ?? [])
          .map((b) => b.documents?.[rule.docName])
          .find((d) => d && (d.provided || d.expiryDate));
        if (!doc) return;

        const { status, daysLeft } = computeDocumentStatus(doc, currentDate, rule.docName);
        if (status !== 'Current' || typeof daysLeft !== 'number') return;
        // Fire on the earliest-crossed early milestone only - once inside 30
        // days the document already surfaces via the standard "Document
        // Expiring Soon" alert, so only thresholds above that count here.
        const milestone = rule.earlyMilestoneDays
          .filter((d) => d > EXPIRING_SOON_DAYS)
          .sort((a, b) => a - b)
          .find((d) => daysLeft <= d);
        if (milestone === undefined) return;

        list.push({
          id: `early-milestone-${rule.docName}-${c.id}`,
          company: c.name,
          surveyType: c.type as SurveyType,
          respondentType: 'Document Expiring Soon',
          submissionDate: new Date(currentDate.getTime() - 1 * 60 * 60 * 1000).toISOString(),
          questionCount: 1,
          respondentEmail: 'system@mgenesis.com',
          department: 'Logistics',
          designation: 'Document Alert',
        });
      });
    });

    return list;
  }, [partnerCompanies, simClock, notificationSettingsVersion]);

  const combinedNotifications = useMemo(() => {
    const list = [...documentNotifications, ...earlyMilestoneNotifications, ...notifications];
    return list.sort((a, b) => b.submissionDate.localeCompare(a.submissionDate));
  }, [documentNotifications, earlyMilestoneNotifications, notifications]);

  const combinedUnreadCount = useMemo(() => {
    return unreadCount + documentNotifications.length;
  }, [unreadCount, documentNotifications]);

  return {
    responses: activeResponses,
    archivedResponses,
    archiveSeries,
    renameArchiveSeries,
    archiveResponsesForSurveys,
    restoreResponseGroup,
    restoreResponsesForSurvey,
    deleteArchivedResponseGroups,
    restoreArchivedResponseGroups,
    importArchivedResponses,
    previewRawEvaluations,
    commitRawEvaluations,
    surveys,
    surveyTypes,
    questions,
    companies,
    partnerCompanies,
    addPartnerCompany,
    updatePartnerCompany,
    updatePartnerCompaniesBulk,
    removePartnerCompany,
    previewMasterListImport,
    commitMasterListImport,
    isLoading,
    error,
    notifications: combinedNotifications,
    unreadCount: combinedUnreadCount,
    markNotificationsRead,
    createSurvey,
    updateSurvey,
    updateSurveysBulk,
    deleteSurvey,
    submitResponse,
    categoryLabels,
    renameCategory,
    restoreDefaultCategories,
    resetAllData,
    isFullDatasetActive,
    clearResponses,
    addEvaluations,
    resetSimulation,
  };
}