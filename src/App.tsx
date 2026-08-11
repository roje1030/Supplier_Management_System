import { useMemo, useRef, useState, useEffect } from 'react';
import { BarChart3, Bell, FileText, LayoutDashboard, Moon, Search, Sun, FilePlus, ClipboardCheck, ArrowLeft, LogOut, ShieldAlert, Users, UserCog, ClipboardList, CircleUserRound, Settings as SettingsIcon } from 'lucide-react';
import { AccountMenu } from './components/AccountMenu';
import { NotificationBell } from './components/NotificationBell';
import { EmployeeNotificationBell } from './components/EmployeeNotificationBell';
import { Shell, NavItem } from './layouts/Shell';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage, MicrosoftAuth } from './pages/LoginPage';
import { restoreMicrosoftAccount, logoutMicrosoft, isMsalConfigured } from './services/msalAuth';
import { signIntoSupabaseWithMicrosoft, signOutSupabase } from './services/authBridge';
import { NotificationLogsPage } from './pages/NotificationLogsPage';
import { EmployeeNotificationLogsPage } from './pages/EmployeeNotificationLogsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SurveyExplorerPage } from './pages/SurveyExplorerPage';
import { CreateSurveyPage } from './pages/CreateSurveyPage';
import { SurveyDetailsPage } from './pages/SurveyDetailsPage';
import { SurveyFillerPage, SurveyFillerHandle } from './pages/SurveyFillerPage';
import { PartnerCompaniesPage } from './pages/PartnerCompaniesPage';
import { DocumentRegisterPage } from './pages/DocumentRegisterPage';
import { SupplierRankingPage } from './pages/SupplierRankingPage';
import { SurveyFormsPage } from './pages/SurveyFormsPage';
import { PresentPage } from './pages/PresentPage';
import { ArchivePage } from './pages/ArchivePage';
import { SimulatorPage } from './pages/SimulatorPage';
import { ImportEvaluationsPage } from './pages/ImportEvaluationsPage';
import { AccountManagementPage } from './pages/AccountManagementPage';
import { PartnersFeedbackHubPage } from './pages/PartnersFeedbackHubPage';
import { MySubmissionsPage } from './pages/MySubmissionsPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { OutstandingEvaluationsPage } from './pages/OutstandingEvaluationsPage';
import { ExportHistoryPage } from './pages/ExportHistoryPage';
import { CategoriesManagerPage } from './pages/CategoriesManagerPage';
import { logAdminActivity } from './utils/adminActivityLog';
import { useSurveyData } from './hooks/useSurveyData';
import { applyFilters, initialFilters } from './utils/analytics';
import { FilterState, SurveyType, CustomForm, SurveyResponse } from './types/survey';
import { PageModuleKey, getDefaultPermissions, hasPageAccess, getDepartmentDefaultPermissions } from './utils/rbac';
import { SimClock, loadSimClock, saveSimClock } from './utils/simClock';
import { SimulatedClockIndicator } from './components/SimulatedClockIndicator';
import { isDemoModeEnabled } from './utils/demoMode';

// Shared by userAccessibleResponses/userAccessibleAllTimeResponses below - the
// same role/department/survey-type scoping rule applied to either the
// active-only response list or the active+archived merged list, so a user's
// visibility rules don't drift between "Current" and "All-Time" data scope.
function applyAccessFilter(
  list: SurveyResponse[],
  profile: { email: string; role: string; designation: string; department: string } | null,
  effectiveSurveyTypes: SurveyType[],
  activePage: string
): SurveyResponse[] {
  if (!profile) return [];
  if (activePage === 'analytics') {
    return list; // Analytics remains company-wide for all users
  }

  if (profile.role === 'Admin' || profile.designation === 'Executive' || profile.designation === 'Director') {
    return list.filter((r) => effectiveSurveyTypes.includes(r.surveyType));
  }

  if (profile.designation === 'Supervisory') {
    return list.filter((r) => r.department === profile.department && effectiveSurveyTypes.includes(r.surveyType));
  }

  if (profile.designation === 'Rank & File') {
    return list.filter((r) => r.respondentEmail === profile.email && effectiveSurveyTypes.includes(r.surveyType));
  }

  return list.filter((r) => effectiveSurveyTypes.includes(r.surveyType));
}

export interface AccountProfile {
  email: string;
  role: string;
  designation: string;
  department: string;
  permissions?: {
    pages: PageModuleKey[];
    surveyTypes: SurveyType[];
  };
}

// Kept even with demo mode off - this is the one bootstrap account needed to
// log in and start adding real employees via Account Management on a fresh
// deployment, not placeholder demo data.
// Real system administrators. Any @mgenesis.com Microsoft account listed here
// is recognized as Admin the moment it signs in, even before an accounts row
// exists for it - so the first admins are never locked out on a fresh system.
// Keep this in sync with supabase/seed_admins.sql (the server-side source of
// truth once RLS enforcement is fully wired).
const BOOTSTRAP_ADMIN_EMAILS = [
  'sheanne.cahinhinan@mgenesis.com',
  'presshel.escleto@mgenesis.com',
];

const BOOTSTRAP_ADMIN_ACCOUNTS: AccountProfile[] = BOOTSTRAP_ADMIN_EMAILS.map((email) => ({
  email,
  role: 'Admin',
  designation: 'Executive',
  department: 'Business Solutions Manager',
}));

// Placeholder roster simulating a multi-department org for demoing/testing
// RBAC. Only seeded when demo mode is enabled - see isDemoModeEnabled().
const DEMO_SEED_ACCOUNTS: AccountProfile[] = [
  // Procurement
  {
    email: 'maria.fernandez@mgenesis.com',
    role: 'Employee',
    designation: 'Rank & File',
    department: 'Procurement Group'
  },
  {
    email: 'carlos.bautista@mgenesis.com',
    role: 'Employee',
    designation: 'Supervisory',
    department: 'Procurement Group'
  },
  {
    email: 'angela.reyes@mgenesis.com',
    role: 'Employee',
    designation: 'Managerial',
    department: 'Procurement Group'
  },

  // Logistics
  {
    email: 'miguel.santos@mgenesis.com',
    role: 'Employee',
    designation: 'Rank & File',
    department: 'Logistics'
  },
  {
    email: 'denise.aquino@mgenesis.com',
    role: 'Employee',
    designation: 'Supervisory',
    department: 'Logistics'
  },
  {
    email: 'ramon.villanueva@mgenesis.com',
    role: 'Employee',
    designation: 'Managerial',
    department: 'Logistics'
  },

  // Accounts Payable - Trade
  {
    email: 'kristine.manalo@mgenesis.com',
    role: 'Employee',
    designation: 'Rank & File',
    department: 'Accounts Payable - Trade'
  },
  {
    email: 'paolo.cruz@mgenesis.com',
    role: 'Employee',
    designation: 'Supervisory',
    department: 'Accounts Payable - Trade'
  },
  {
    email: 'bianca.torres@mgenesis.com',
    role: 'Employee',
    designation: 'Managerial',
    department: 'Accounts Payable - Trade'
  },

  // Business Solutions Manager (BSM)
  {
    email: 'joshua.ramos@mgenesis.com',
    role: 'Employee',
    designation: 'Rank & File',
    department: 'Business Solutions Manager'
  },
  {
    email: 'katrina.lopez@mgenesis.com',
    role: 'Employee',
    designation: 'Supervisory',
    department: 'Business Solutions Manager'
  },
  {
    email: 'nathaniel.garcia@mgenesis.com',
    role: 'Employee',
    designation: 'Managerial',
    department: 'Business Solutions Manager'
  },
  {
    email: 'estrella.domingo@mgenesis.com',
    role: 'Employee',
    designation: 'Director',
    department: 'Business Solutions Manager'
  },

  // TASS
  {
    email: 'julius.mercado@mgenesis.com',
    role: 'Employee',
    designation: 'Rank & File',
    department: 'TASS'
  },
  {
    email: 'corazon.ilagan@mgenesis.com',
    role: 'Employee',
    designation: 'Supervisory',
    department: 'TASS'
  },
  {
    email: 'vincent.alvarez@mgenesis.com',
    role: 'Employee',
    designation: 'Managerial',
    department: 'TASS'
  },
  {
    email: 'patricia.navarro@mgenesis.com',
    role: 'Employee',
    designation: 'Director',
    department: 'TASS'
  },

  // Executive Office (new department)
  {
    email: 'rafael.concepcion@mgenesis.com',
    role: 'Employee',
    designation: 'Executive',
    department: 'Executive Office'
  }
];

const DEFAULT_ACCOUNTS: AccountProfile[] = isDemoModeEnabled()
  ? [...BOOTSTRAP_ADMIN_ACCOUNTS, ...DEMO_SEED_ACCOUNTS]
  : [...BOOTSTRAP_ADMIN_ACCOUNTS];

type PageKey = 'dashboard' | 'partner-companies' | 'document-register' | 'supplier-ranking' | 'partners-feedback-hub' | 'account-management' | 'survey-forms' | 'analytics' | 'present' | 'explorer' | 'reports' | 'notifications' | 'create-form' | 'view-form' | 'fill-form' | 'archive' | 'simulator' | 'import-evaluations' | 'my-submissions' | 'profile-settings' | 'pending-review' | 'export-history' | 'settings' | 'categories-manager';

// Admin sidebar: grouped by workflow stage (raw data -> insight -> output)
// rather than flat/alphabetical, per the dashboard IA redesign.
const adminNavItems: NavItem<PageKey>[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  {
    type: 'group',
    id: 'group-suppliers',
    // "Partner Companies" (not "Suppliers") - the registry covers Couriers
    // and Subcontractors too, and "Suppliers" is only one of those three
    // categories.
    label: 'Partner Companies',
    icon: Users,
    children: [
      { key: 'partner-companies', label: 'Partner Companies' },
      { key: 'document-register', label: 'Document Tracker' },
      { key: 'supplier-ranking', label: 'Supplier Ranking' },
      { key: 'partners-feedback-hub', label: 'Feedback Hub' },
    ],
  },
  {
    type: 'group',
    id: 'group-evaluations',
    label: 'Evaluations',
    icon: ClipboardCheck,
    children: [
      { key: 'survey-forms', label: 'All Submissions' },
      { key: 'pending-review', label: 'Outstanding Evaluations' },
      { key: 'explorer', label: 'Raw Data Explorer' },
      { key: 'archive', label: 'Archive Center' },
      { key: 'categories-manager', label: 'Categories Manager' },
    ],
  },
  // Single page already covers trends + company comparisons together, so
  // it's one flat destination rather than a group of near-duplicate items.
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  {
    type: 'group',
    id: 'group-reports',
    label: 'Reports & Exports',
    icon: FileText,
    children: [
      { key: 'reports', label: 'Generate Report' },
      { key: 'present', label: 'Present Mode' },
      { key: 'export-history', label: 'Export History' },
    ],
  },
  { key: 'account-management', label: 'Employees / Users', icon: UserCog },
  // General admin notification log (document expiry alerts, survey
  // submissions) - already existed as a page, only reachable before now
  // via the bell's "View all" link.
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

const allSurveyTypes: SurveyType[] = ['Courier', 'Supplier', 'Subcontractor'];

export default function App() {
  const [account, setAccount] = useState<string | null>(() => {
    // When Microsoft SSO is configured it is the source of truth: identity is
    // restored from the MSAL cache in the effect below, and a bare
    // localStorage string can no longer grant access (that was the old
    // bypass). Only trust localStorage in dev when SSO is unconfigured.
    if (isMsalConfigured()) return null;
    return localStorage.getItem('user_account') || null;
  });
  // Gates the first paint until we've asked MSAL whether a real signed-in
  // account exists, so we never flash the app before auth is verified.
  const [authChecked, setAuthChecked] = useState(() => !isMsalConfigured());

  // 'current' = active period only (today's default, unchanged behavior).
  // 'all-time' = active + every archived period combined, so multi-year
  // company trends accumulate across resets instead of blanking out each time
  // a survey period is archived. 'custom' = only the archived series picked
  // in selectedSeriesIds. Shared across Dashboard/Analytics so switching in
  // one keeps the other consistent (Dashboard doesn't offer 'custom' itself
  // and falls back to 'current' if it's ever selected elsewhere).
  const [dataScope, setDataScope] = useState<'current' | 'all-time' | 'custom'>('current');
  const [selectedSeriesIds, setSelectedSeriesIds] = useState<string[]>([]);

  // Simulated system clock (Database Simulator "time travel") - persisted so
  // it survives reloads like an actual changed system clock would. null
  // means "real time," everything else reads through utils/simClock.ts.
  const [simClock, setSimClockState] = useState<SimClock | null>(() => loadSimClock());
  const setSimClock = (clock: SimClock | null) => {
    setSimClockState(clock);
    saveSimClock(clock);
  };

  // Accounts Management State
  const [accounts, setAccounts] = useState<AccountProfile[]>(() => {
    const saved = localStorage.getItem('survey_accounts_v1');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return DEFAULT_ACCOUNTS;
      }
    }
    return DEFAULT_ACCOUNTS;
  });

  const saveAccounts = (newAccounts: AccountProfile[]) => {
    setAccounts(newAccounts);
    localStorage.setItem('survey_accounts_v1', JSON.stringify(newAccounts));
    logAdminActivity('Updated employee accounts', `${newAccounts.length} account${newAccounts.length === 1 ? '' : 's'} on file`);
  };

  const [departmentPermissions, setDepartmentPermissions] = useState<Record<string, { pages: PageModuleKey[]; surveyTypes: SurveyType[] }>>(() => {
    const saved = localStorage.getItem('survey_department_permissions_v1');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return {};
      }
    }
    return {};
  });

  const saveDepartmentPermissions = (newPerms: Record<string, { pages: PageModuleKey[]; surveyTypes: SurveyType[] }>) => {
    setDepartmentPermissions(newPerms);
    localStorage.setItem('survey_department_permissions_v1', JSON.stringify(newPerms));
    logAdminActivity('Updated department permissions');
  };

  const getUserProfile = (email: string | null) => {
    if (!email) return null;
    const normalized = email.trim().toLowerCase();
    const matched = accounts.find((acc) => acc.email.trim().toLowerCase() === normalized);
    if (matched) return matched;
    // Bootstrap admins are always Admin, even if no accounts row exists yet.
    if (BOOTSTRAP_ADMIN_EMAILS.includes(normalized)) {
      return {
        email: normalized,
        role: 'Admin',
        designation: 'Executive',
        department: 'Business Solutions Manager',
      };
    }
    return {
      email: normalized,
      role: 'Employee',
      designation: 'Rank & File',
      department: 'Logistics'
    };
  };

  const profile = useMemo(() => getUserProfile(account), [account, accounts]);

  // centralize user permissions mapping based on active profile and overrides
  const userPermissions = useMemo(() => {
    if (!profile) return { pages: [] as PageModuleKey[], surveyTypes: [] as SurveyType[] };
    
    // System Administrator gets full unrestricted access unless custom overridden
    if (profile.role === 'Admin' && !profile.permissions) {
      return {
        pages: [
          'dashboard', 'survey-forms', 'explorer', 'analytics', 'reports', 'present',
          'partner-companies', 'document-register', 'renew-documents', 'supplier-ranking', 'partners-feedback-hub', 'account-management', 'notifications', 'archive', 'import-evaluations',
          // Database Simulator is demo/testing tooling only - excluded once
          // VITE_ENABLE_DEMO_MODE is turned off.
          ...(isDemoModeEnabled() ? ['simulator' as PageModuleKey] : []),
        ] as PageModuleKey[],
        surveyTypes: ['Courier', 'Supplier', 'Subcontractor'] as SurveyType[]
      };
    }

    const defaults = getDefaultPermissions(profile.designation, profile.department);
    const userPages = (profile.permissions?.pages ?? defaults.pages) as PageModuleKey[];
    const userSurveyTypes = (profile.permissions?.surveyTypes ?? defaults.surveyTypes) as SurveyType[];

    const deptPerms = departmentPermissions[profile.department] || getDepartmentDefaultPermissions(profile.department);
    return {
      pages: userPages.filter(p => deptPerms.pages.includes(p)) as PageModuleKey[],
      surveyTypes: userSurveyTypes.filter(t => deptPerms.surveyTypes.includes(t)) as SurveyType[]
    };
  }, [profile, departmentPermissions]);

  const isAdmin = profile?.role === 'Admin' || userPermissions.pages.includes('account-management');
  // Assignable independently of full Admin - lets a role be granted document
  // renewal rights (Partner Companies + Document Register) without also
  // granting Account Management / full system access.
  const canRenewDocuments = isAdmin || userPermissions.pages.includes('renew-documents');

  const {
    responses,
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
    notifications,
    unreadCount,
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
  } = useSurveyData(accounts, account, isAdmin, simClock);

  const [activePage, setActivePage] = useState<PageKey>('dashboard');

  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);
  const surveyFillerRef = useRef<SurveyFillerHandle>(null);

  // Any navigation away from the survey-filling page (sidebar Home logo, a
  // top-level nav item, or picking a different survey from the sidebar
  // dropdown) should go through this, so an in-progress evaluation can warn
  // the respondent and offer to save a draft instead of silently discarding
  // their answers.
  const navigateFrom = (targetPage: PageKey, run: () => void) => {
    if (activePage === 'fill-form' && targetPage !== 'fill-form' && surveyFillerRef.current) {
      surveyFillerRef.current.attemptExit(run);
    } else {
      run();
    }
  };
  const [editingSurveyId, setEditingSurveyId] = useState<string | null>(null);

  // Deep-link into Partner Companies' detail/edit panel for one specific
  // company (e.g. from a notification click-through).
  const [focusCompanyId, setFocusCompanyId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [darkMode, setDarkMode] = useState(false);

  const handleResetAllData = () => {
    logAdminActivity('Reset system database');
    resetAllData();
  };

  // A survey's own "Department / Role Access" checkboxes (set via Survey Forms > Modify)
  // are the source of truth for who can see & answer that specific form. If a survey has
  // been explicitly shared with someone's department + rank, that alone should be enough
  // to unlock it for them - they shouldn't also need a separate category checkbox flipped
  // in Account Management. This computes which survey categories have been unlocked for
  // the current user purely through form-level access grants.
  const formGrantedSurveyTypes = useMemo(() => {
    const set = new Set<SurveyType>();
    if (!profile || profile.role === 'Admin') return set;
    surveys.forEach((survey) => {
      if (survey.status === 'Archived') return;
      const departmentAccess = survey.accessDepartments;
      const roleAccess = survey.accessRoles;
      const allowsDepartment = !departmentAccess?.length || departmentAccess.includes(profile.department);
      const allowsRole = !roleAccess?.length || roleAccess.includes(profile.designation as any);
      if (allowsDepartment && allowsRole) set.add(survey.surveyType);
    });
    return set;
  }, [surveys, profile]);

  // Effective survey type access = whatever Account Management grants, PLUS whatever
  // any individual survey's own access settings grant. This is a union (additive) so it
  // never revokes what Account Management already allows - it only extends access when
  // an admin explicitly shares a specific form with a department/role.
  const effectiveSurveyTypes = useMemo<SurveyType[]>(() => {
    const set = new Set<SurveyType>([...userPermissions.surveyTypes, ...formGrantedSurveyTypes]);
    return Array.from(set);
  }, [userPermissions.surveyTypes, formGrantedSurveyTypes]);

  const canExport = useMemo(() => {
    if (!profile) return false;
    return profile.role === 'Admin' || profile.designation !== 'Rank & File';
  }, [profile]);

  // Centralized Data Isolation & Filtering based on user department/rank/permitted types
  const userAccessibleResponses = useMemo(
    () => applyAccessFilter(responses, profile, effectiveSurveyTypes, activePage),
    [responses, profile, effectiveSurveyTypes, activePage]
  );

  // The same active responses merged with every archived period, still
  // scoped by the same role/department rules - this is the "All-Time" data
  // source. Archived responses never overlap with active ones (archiving
  // just flips a flag on the same row, see useSurveyData.ts), so this concat
  // is a safe, dedup-free union of the full history.
  const historyResponsesRaw = useMemo(() => [...responses, ...archivedResponses], [responses, archivedResponses]);
  const userAccessibleAllTimeResponses = useMemo(
    () => applyAccessFilter(historyResponsesRaw, profile, effectiveSurveyTypes, activePage),
    [historyResponsesRaw, profile, effectiveSurveyTypes, activePage]
  );
  // Archived responses belonging to the series picked in the Analytics
  // "Custom" scope. Series only exist on archived rows (stamped at archive
  // time), so this never includes anything from the current/active period.
  const customScopedResponsesRaw = useMemo(
    () => (selectedSeriesIds.length ? historyResponsesRaw.filter((r) => r.seriesId && selectedSeriesIds.includes(r.seriesId)) : []),
    [historyResponsesRaw, selectedSeriesIds]
  );
  const userAccessibleCustomResponses = useMemo(
    () => applyAccessFilter(customScopedResponsesRaw, profile, effectiveSurveyTypes, activePage),
    [customScopedResponsesRaw, profile, effectiveSurveyTypes, activePage]
  );
  // Whichever of the three the current toggle selects - this is what most
  // scope-aware pages (Dashboard/Reports/Present/Explorer) should consume.
  const scopedAccessibleResponses =
    dataScope === 'all-time' ? userAccessibleAllTimeResponses :
    dataScope === 'custom' ? userAccessibleCustomResponses :
    userAccessibleResponses;

  const userAccessibleAllResponses = useMemo(() => {
    if (!profile) return [];
    if (activePage === 'analytics') {
      return responses;
    }

    if (profile.role === 'Admin' || profile.designation === 'Executive' || profile.designation === 'Director') {
      return responses.filter(r => effectiveSurveyTypes.includes(r.surveyType));
    }

    if (profile.designation === 'Supervisory') {
      return responses.filter(r => 
        r.department === profile.department && 
        effectiveSurveyTypes.includes(r.surveyType)
      );
    }

    if (profile.designation === 'Rank & File') {
      return responses.filter(r => 
        r.respondentEmail === profile.email && 
        effectiveSurveyTypes.includes(r.surveyType)
      );
    }

    return responses.filter(r => effectiveSurveyTypes.includes(r.surveyType));
  }, [responses, profile, effectiveSurveyTypes, activePage]);

  const userAccessibleSurveys = useMemo(() => {
    return surveys.filter((survey) => {
      if (!profile || profile.role === 'Admin') return true;
      if (!effectiveSurveyTypes.includes(survey.surveyType)) return false;

      const departmentAccess = survey.accessDepartments;
      const roleAccess = survey.accessRoles;
      const allowsDepartment = !departmentAccess?.length || departmentAccess.includes(profile.department);
      const allowsRole = !roleAccess?.length || roleAccess.includes(profile.designation as any);
      return allowsDepartment && allowsRole;
    });
  }, [surveys, effectiveSurveyTypes, profile]);

  const userAccessiblePartnerCompanies = useMemo(() => {
    // Uncategorized companies (pending review, no assigned survey type) are
    // never accessible here — same behavior as before this type existed.
    // Archived companies (demo-only entries with no real Master List match,
    // or anything an admin has archived) are excluded too: every page fed by
    // this list (dashboard stats, reports, presentation, feedback hub) should
    // only ever see the live registry, matching the Partner Registry's own
    // Active tab.
    return partnerCompanies.filter(c => !c.isArchived && effectiveSurveyTypes.some(t => t === c.type));
  }, [partnerCompanies, effectiveSurveyTypes]);

  const filteredResponses = useMemo(() => applyFilters(scopedAccessibleResponses, filters), [scopedAccessibleResponses, filters]);
  const analyticsFilteredResponses = useMemo(
    () => applyFilters(
      dataScope === 'all-time' ? historyResponsesRaw :
      dataScope === 'custom' ? customScopedResponsesRaw :
      responses,
      filters
    ),
    [dataScope, historyResponsesRaw, customScopedResponsesRaw, responses, filters]
  );
  
  const activeSurveyTypes = filters.surveyType.length ? filters.surveyType : effectiveSurveyTypes;


  // Employee sidebar: simple, task-focused, flat (no groups). Every
  // authenticated employee gets the same 5 items regardless of rank -
  // deeper per-rank data scoping still applies to the pages themselves via
  // applyAccessFilter/userPermissions, just not to which nav items show.
  const employeeNavItems: NavItem<PageKey>[] = useMemo(
    () => [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'fill-form', label: 'New Evaluation', icon: FilePlus },
      { key: 'my-submissions', label: 'My Submissions', icon: ClipboardList },
      { key: 'notifications', label: 'Notifications', icon: Bell },
      { key: 'profile-settings', label: 'Profile / Settings', icon: CircleUserRound },
    ],
    []
  );

  const visiblePages = isAdmin ? adminNavItems : employeeNavItems;

  // Flattened lookup (groups expanded) used for the title/heading and the
  // route-guard fallback below, regardless of whether the current role's
  // nav is grouped or flat.
  const flatNavLeaves = useMemo(
    () =>
      visiblePages.flatMap((item) =>
        item.type === 'group' ? item.children.map((child) => ({ key: child.key, label: child.label })) : [{ key: item.key, label: item.label }]
      ),
    [visiblePages]
  );

  const activeTitle = useMemo(() => {
    if (activePage === 'dashboard') {
      return 'Dashboard';
    }
    if (activePage === 'partner-companies') return 'Administrative Partner Registry';
    if (activePage === 'document-register') return 'Document Tracker';
    if (activePage === 'account-management') return 'Account Management';
    if (activePage === 'create-form') return editingSurveyId ? 'Edit Survey Form' : 'Create Survey Form';
    if (activePage === 'view-form') {
      const selected = surveys.find((s) => s.id === selectedSurveyId);
      return selected ? `Survey: ${selected.title}` : 'Survey Details';
    }
    if (activePage === 'fill-form') return 'Fill Out Stakeholder Survey';
    if (activePage === 'simulator') return 'Database Simulator';
    if (activePage === 'import-evaluations') return 'Import Evaluation Responses';
    return flatNavLeaves.find((page) => page.key === activePage)?.label ?? 'Dashboard';
  }, [activePage, selectedSurveyId, surveys, editingSurveyId, profile, flatNavLeaves]);

  const pageHeading = useMemo(() => {
    if (activePage === 'dashboard') {
      const namePart = profile?.email ? profile.email.split('@')[0] : 'User';
      const capitalizedName = namePart
        .split('.')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      return `Welcome Back, ${capitalizedName || 'User'}!`;
    }
    return activeTitle;
  }, [activePage, activeTitle, profile]);

  // Safe routing guard redirecting users to permitted views
  useEffect(() => {
    if (!account) return;
    const currentIsAllowed = hasPageAccess(userPermissions.pages, activePage, isAdmin);
    if (!currentIsAllowed) {
      const fallback = flatNavLeaves[0]?.key || 'dashboard';
      setActivePage(fallback as PageKey);
    }
  }, [activePage, userPermissions.pages, flatNavLeaves, account, isAdmin]);

  // On load, restore identity from the MSAL cache (a real prior Microsoft
  // sign-in) rather than trusting a localStorage string. If there's no cached
  // Microsoft account, the user is treated as signed out.
  useEffect(() => {
    if (!isMsalConfigured()) return;
    let cancelled = false;
    (async () => {
      try {
        const acct = await restoreMicrosoftAccount();
        if (cancelled) return;
        const email = acct?.username?.trim().toLowerCase();
        if (email && email.endsWith('@mgenesis.com')) {
          setAccount(email);
          localStorage.setItem('user_account', email);
        } else {
          setAccount(null);
          localStorage.removeItem('user_account');
        }
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = (email: string, auth?: MicrosoftAuth) => {
    setAccount(email);
    localStorage.setItem('user_account', email);
    setActivePage('dashboard');
    // Best-effort: exchange the Microsoft ID token for a Supabase session so
    // Postgres RLS can enforce access. A failure here (e.g. Azure provider not
    // yet enabled in Supabase) is logged but does not block the user - their
    // Microsoft identity is already verified. See supabase/seed_admins.sql.
    if (auth) {
      signIntoSupabaseWithMicrosoft(auth.idToken, auth.nonce).then((res) => {
        if (!res.ok) console.warn('[auth] Supabase session not established:', res.error);
      });
    }
  };

  const handleLogout = () => {
    setAccount(null);
    localStorage.removeItem('user_account');
    void signOutSupabase();
    void logoutMicrosoft();
  };

  // Hold the first paint until MSAL has been consulted, so the app never
  // flashes before we know whether the user is really signed in.
  if (!authChecked) {
    return <div className="min-h-screen w-full bg-white" />;
  }

  // Auth Guard
  if (!account) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Handler for custom survey submission
  const handleSurveySubmit = (
    surveyId: string,
    company: string,
    department: string,
    respondentType: string,
    address: string | undefined,
    answers: any[],
    startTime?: string
  ) => {
    submitResponse(surveyId, company, department, respondentType, address, answers, account || undefined, startTime);
  };

  // ----------------------------------------------------
  // ADMIN EXPERIENCE (ALL ANALYTICS SECURED HERE)
  // ----------------------------------------------------
  const pageContent = {
    dashboard: (
      <DashboardPage
        responses={filteredResponses}
        allResponses={userAccessibleAllResponses}
        historyResponses={dataScope === 'all-time' ? userAccessibleAllTimeResponses : userAccessibleAllResponses}
        dataScope={dataScope === 'custom' ? 'current' : dataScope}
        onChangeDataScope={setDataScope}
        partnerCompanies={userAccessiblePartnerCompanies}
        isLoading={isLoading}
        error={error}
        surveyTypeFilter={filters.surveyType}
        surveys={userAccessibleSurveys}
        isAdmin={isAdmin}
        userEmail={account || ''}
      />
    ),
    'partner-companies': (
      <PartnerCompaniesPage
        // Unfiltered on purpose: this is the admin registry itself (Active/
        // Expired/Archived tabs), so Uncategorized companies pending review
        // must stay visible here even though they're excluded from every
        // survey-scoped view via userAccessiblePartnerCompanies.
        partnerCompanies={partnerCompanies}
        responses={userAccessibleResponses}
        simClock={simClock}
        onAddCompany={addPartnerCompany}
        onRemoveCompany={removePartnerCompany}
        onUpdateCompany={updatePartnerCompany}
        onPreviewMasterListImport={previewMasterListImport}
        onCommitMasterListImport={commitMasterListImport}
        isAdmin={isAdmin}
        canRenewDocuments={canRenewDocuments}
        initialFocusCompanyId={focusCompanyId}
        onFocusConsumed={() => setFocusCompanyId(null)}
        currentUserEmail={account || ''}
      />
    ),
    'document-register': (
      <DocumentRegisterPage
        partnerCompanies={partnerCompanies}
        simClock={simClock}
        canRenewDocuments={canRenewDocuments}
        onUpdateCompany={updatePartnerCompany}
        currentUserEmail={account || ''}
      />
    ),
    'supplier-ranking': (
      <SupplierRankingPage
        partnerCompanies={partnerCompanies}
        onUpdateCompaniesBulk={updatePartnerCompaniesBulk}
        surveys={surveys}
        responses={responses}
        currentUserEmail={account || ''}
      />
    ),
    'partners-feedback-hub': (
      <PartnersFeedbackHubPage
        surveys={userAccessibleSurveys}
        responses={userAccessibleResponses}
        partnerCompanies={userAccessiblePartnerCompanies}
        accounts={accounts}
        simClock={simClock}
        currentUser={profile}
        onNavigatePage={(p) => setActivePage(p as PageKey)}
        onMarkSurveyComplete={(id) => {
          const target = surveys.find((s) => s.id === id);
          if (target) updateSurvey({ ...target, status: 'Completed' });
        }}
      />
    ),
    'account-management': (
      <AccountManagementPage 
        accounts={accounts}
        onUpdateAccounts={saveAccounts}
        isAdmin={isAdmin}
        currentUserEmail={account || ''}
        departmentPermissions={departmentPermissions}
        onUpdateDepartmentPermissions={saveDepartmentPermissions}
      />
    ),
    'survey-forms': (
      <SurveyFormsPage
        surveys={userAccessibleSurveys}
        responses={userAccessibleResponses}
        partnerCompanies={userAccessiblePartnerCompanies}
        userEmail={account || ''}
        simClock={simClock}
        onUpdateSurvey={updateSurvey}
        onUpdateSurveysBulk={updateSurveysBulk}
        onArchiveResponses={archiveResponsesForSurveys}
        onSelectSurvey={(id) => {
          setSelectedSurveyId(id);
          setActivePage('view-form');
        }}
        onNavigateToCreate={() => setActivePage('create-form')}
        onFillForm={(id) => {
          setSelectedSurveyId(id);
          setActivePage('fill-form');
        }}
        isAdmin={isAdmin}
      />
    ),
    analytics: (
      <AnalyticsPage
        responses={analyticsFilteredResponses}
        allResponses={dataScope === 'all-time' ? historyResponsesRaw : dataScope === 'custom' ? customScopedResponsesRaw : responses}
        partnerCompanies={partnerCompanies}
        activeSurveyTypes={allSurveyTypes}
        filters={filters}
        setFilters={setFilters}
        dataScope={dataScope}
        onChangeDataScope={setDataScope}
        archiveSeries={archiveSeries}
        selectedSeriesIds={selectedSeriesIds}
        onChangeSelectedSeriesIds={setSelectedSeriesIds}
      />
    ),
    present: <PresentPage responses={scopedAccessibleResponses} partnerCompanies={userAccessiblePartnerCompanies} />,
    explorer: <SurveyExplorerPage responses={filteredResponses} surveys={userAccessibleSurveys} />,
    reports: (
      <ReportsPage
        responses={filteredResponses}
        partnerCompanies={userAccessiblePartnerCompanies}
        canExport={canExport}
      />
    ),
    'export-history': <ExportHistoryPage />,
    'pending-review': (
      <OutstandingEvaluationsPage
        surveys={surveys}
        partnerCompanies={partnerCompanies}
        responses={responses}
      />
    ),
    'my-submissions': (
      <MySubmissionsPage
        responses={userAccessibleAllTimeResponses}
        userEmail={account || ''}
        onFillForm={() => setActivePage('fill-form')}
      />
    ),
    'profile-settings': profile && (
      <ProfilePage
        email={account || ''}
        role={profile.role}
        designation={profile.designation}
        department={profile.department}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((value) => !value)}
        onLogout={handleLogout}
        responses={userAccessibleAllTimeResponses}
        onViewAllSubmissions={() => setActivePage('my-submissions')}
      />
    ),
    settings: profile && (
      <SettingsPage
        email={account || ''}
        role={profile.role}
        designation={profile.designation}
        department={profile.department}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((value) => !value)}
        onOpenSimulator={() => setActivePage('simulator')}
        onOpenImportEvaluations={() => setActivePage('import-evaluations')}
        onResetSystemData={handleResetAllData}
        onLogout={handleLogout}
        accountsCount={accounts.length}
        activePartnerCompaniesCount={partnerCompanies.filter((c) => !c.isArchived).length}
        totalResponsesCount={responses.length}
      />
    ),
    notifications: isAdmin ? (
      <NotificationLogsPage notifications={notifications} unreadCount={unreadCount} />
    ) : (
      profile && (
        <EmployeeNotificationLogsPage
          userEmail={account || ''}
          profile={profile}
          surveys={surveys}
          partnerCompanies={partnerCompanies}
          responses={responses}
          onFillForm={(id) => {
            setSelectedSurveyId(id);
            setActivePage('fill-form');
          }}
        />
      )
    ),
    'create-form': (
      <CreateSurveyPage
        onBack={() => {
          setEditingSurveyId(null);
          setActivePage('dashboard');
        }}
        surveyToEdit={editingSurveyId ? surveys.find(s => s.id === editingSurveyId) : undefined}
        categoryLabels={categoryLabels}
        onSave={(surveyData) => {
          if (editingSurveyId) {
            const currentSurvey = surveys.find(s => s.id === editingSurveyId);
            updateSurvey({
              ...surveyData,
              id: editingSurveyId,
              createdAt: currentSurvey?.createdAt || new Date().toISOString(),
            });
            setEditingSurveyId(null);
            setActivePage('view-form');
          } else {
            const newSurvey = createSurvey(surveyData);
            if (newSurvey) {
              setSelectedSurveyId(newSurvey.id);
              setActivePage('view-form');
            }
          }
        }}
      />
    ),
    'view-form': (() => {
      const targetSurvey = surveys.find((s) => s.id === selectedSurveyId);
      if (!targetSurvey) {
        return (
          <div className="panel p-8 text-center text-slate-500">
            <ShieldAlert size={36} className="mx-auto mb-2 text-rose-500" />
            <p className="font-semibold">Survey not found or was deleted.</p>
            <button onClick={() => setActivePage('dashboard')} className="primary-button mt-4">Return to Dashboard</button>
          </div>
        );
      }
      return (
        <SurveyDetailsPage
          survey={targetSurvey}
          responses={userAccessibleResponses}
          partnerCompanies={userAccessiblePartnerCompanies}
          userEmail={account || ''}
          onBack={() => setActivePage('survey-forms')}
          onDelete={(id) => {
            deleteSurvey(id);
            setActivePage('survey-forms');
          }}
          onEdit={(id) => {
            setEditingSurveyId(id);
            setActivePage('create-form');
          }}
          isAdmin={isAdmin}
        />
      );
    })(),
    'fill-form': (
      <SurveyFillerPage
        ref={surveyFillerRef}
        surveys={userAccessibleSurveys}
        partnerCompanies={userAccessiblePartnerCompanies}
        initialSurveyId={selectedSurveyId}
        userEmail={account || ''}
        defaultDepartment={profile?.department}
        defaultRespondentType={profile?.designation}
        responses={userAccessibleResponses}
        onSubmitted={handleSurveySubmit}
        onCancel={() => setActivePage('view-form')}
      />
    ),
    archive: (
      <ArchivePage
        surveys={userAccessibleSurveys}
        archivedResponses={archivedResponses}
        archiveSeries={archiveSeries}
        onRenameArchiveSeries={renameArchiveSeries}
        onUpdateSurvey={updateSurvey}
        onRestoreResponseGroup={restoreResponseGroup}
        onRestoreResponsesForSurvey={restoreResponsesForSurvey}
        onDeleteArchivedResponseGroups={deleteArchivedResponseGroups}
        onRestoreArchivedResponseGroups={restoreArchivedResponseGroups}
        onImportArchivedResponses={importArchivedResponses}
        isAdmin={isAdmin}
      />
    ),
    simulator: (
      <SimulatorPage
        responses={responses}
        archivedResponses={archivedResponses}
        onSimulate={addEvaluations}
        onResetSimulation={resetSimulation}
        simClock={simClock}
        onSetSimClock={(isoDateTime) => setSimClock({ anchorIso: isoDateTime, activatedAtMs: Date.now() })}
        onClearSimClock={() => setSimClock(null)}
      />
    ),
    'import-evaluations': (
      <ImportEvaluationsPage onPreview={previewRawEvaluations} onCommit={commitRawEvaluations} />
    ),
    'categories-manager': (
      <CategoriesManagerPage
        categoryLabels={categoryLabels}
        onRenameCategory={renameCategory}
        onRestoreDefaults={restoreDefaultCategories}
      />
    ),
  }[activePage];

  return (
    <div className={darkMode ? 'dark' : ''}>
      <Shell
        pages={visiblePages}
        activePage={activePage as any}
        onPageChange={(page) => {
          const targetPage = page as PageKey;
          navigateFrom(targetPage, () => {
            setActivePage(targetPage);
            if (targetPage === 'notifications') markNotificationsRead();
          });
        }}
        title={activeTitle}
        pageHeading={pageHeading}
        action={
          <div className="flex items-center divide-x divide-blue-400/25">
            <div className="pr-3 hidden md:block">
              <SimulatedClockIndicator simClock={simClock} />
            </div>
            {isAdmin ? (
              <div className="pr-3">
                <NotificationBell
                  notifications={notifications}
                  unreadCount={unreadCount}
                  onOpen={markNotificationsRead}
                  onViewAll={() => setActivePage('notifications')}
                />
              </div>
            ) : (
              <div className="pr-3">
                <EmployeeNotificationBell
                  userEmail={account || ''}
                  surveys={surveys}
                  partnerCompanies={partnerCompanies}
                  responses={responses}
                  onFillForm={(id) => {
                    setSelectedSurveyId(id);
                    setActivePage('fill-form');
                  }}
                  onViewAll={() => setActivePage('notifications')}
                  variant="header"
                />
              </div>
            )}
            <div className="px-3">
              <button
                className={`inline-flex h-10 w-10 items-center justify-center rounded-lg transition cursor-pointer ${
                  darkMode ? 'bg-white/10 text-white' : 'text-blue-100 hover:text-white'
                }`}
                type="button"
                onClick={() => setDarkMode((value) => !value)}
                title="Toggle dark mode"
              >
                {darkMode ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
            <div className="pl-3">
              <AccountMenu
                email={account}
                designation={profile?.designation}
                department={profile?.department}
                role={profile?.role}
                onLogout={handleLogout}
              />
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">{pageContent}</div>
          </div>
          
          {isAdmin && activePage !== 'notifications' && activePage !== 'create-form' && activePage !== 'fill-form' && activePage !== 'present' && activePage !== 'partners-feedback-hub' && activePage !== 'settings' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <Search size={16} className="text-[#0063a9] dark:text-blue-400 shrink-0" />
                <span>
                  Data Engine: Local Microsoft Forms creation model. Submissions immediately refresh visual analytics in real-time.
                </span>
              </div>
              <button
                onClick={handleResetAllData}
                className="text-xs font-bold text-rose-500 hover:text-rose-600 hover:underline transition shrink-0 cursor-pointer"
                title="Re-seed standard reports and database values"
              >
                Reset System Database
              </button>
            </div>
          )}
        </div>
      </Shell>
    </div>
  );
}
