import { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Trash2, 
  RotateCcw, 
  ChevronLeft, 
  ChevronRight, 
  Maximize2, 
  Minimize2, 
  Award, 
  ClipboardList, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  TrendingUp, 
  Settings2, 
  HelpCircle,
  Sparkles,
  BarChart3,
  ListCollapse,
  Layers,
  ChevronDown,
  LayoutGrid
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PartnerCompany, SurveyResponse, SurveyType, Survey } from '../types/survey';
import {
  submissionCount,
  averageRating,
  submissionScores,
  questionPerformance,
  getSurveyEvaluationCompanies,
  computeRankScore,
} from '../utils/analytics';
import { computeCategoryRankSummary } from '../utils/categorySummary';
import { formatCompositeScore } from '../data/questionWeights';

// ----------------------------------------------------
// TYPES & WIDGET DEFINITIONS
// ----------------------------------------------------

export type WidgetType = 
  | 'satisfaction-gauge' 
  | 'active-forms' 
  | 'recent-submissions' 
  | 'question-scores' 
  | 'group-comparison' 
  | 'volume-tracker';

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title: string;
  gridSpan: 1 | 2 | 3; // 1 = 1 column, 2 = 2 columns, 3 = full width
}

interface DashboardPageProps {
  responses: SurveyResponse[];
  allResponses: SurveyResponse[];
  // Same shape as allResponses, but reflecting whichever data scope is
  // active (current period only, or every archived period combined too).
  // Used only for the historical-style stats (Top Performing Partner,
  // Stakeholder Group Comparison) - completion tracking always uses
  // allResponses regardless, since "who still needs to answer this round"
  // must never be affected by viewing All-Time history.
  historyResponses?: SurveyResponse[];
  dataScope?: 'current' | 'all-time';
  onChangeDataScope?: (scope: 'current' | 'all-time') => void;
  partnerCompanies: PartnerCompany[];
  isLoading: boolean;
  error: string | null;
  surveyTypeFilter: SurveyType[];
  surveys?: Survey[];
  isAdmin?: boolean;
  userEmail?: string;
}

const ALL_WIDGET_CATALOG: { type: WidgetType; title: string; desc: string; defaultSpan: 1 | 2 | 3; category: 'Analytics' | 'Surveys' | 'Submissions' }[] = [
  { 
    type: 'satisfaction-gauge', 
    title: 'Top Performing Partner', 
    desc: 'Displays the highest-rated active partner company with a prominent satisfaction radial gauge.', 
    defaultSpan: 2,
    category: 'Analytics'
  },
  { 
    type: 'volume-tracker', 
    title: 'Response Statistics Feed', 
    desc: 'High-level telemetry on submissions volume, completion rates, and active partner counts.', 
    defaultSpan: 1,
    category: 'Submissions'
  },
  { 
    type: 'group-comparison', 
    title: 'Stakeholder Group Comparison', 
    desc: 'A comparative review of satisfaction score metrics across Couriers, Suppliers, and Subcontractors.', 
    defaultSpan: 1,
    category: 'Analytics'
  },
  { 
    type: 'active-forms', 
    title: 'Published Survey Forms', 
    desc: 'Overview of live questionnaires, response counters, and close dates.', 
    defaultSpan: 1,
    category: 'Surveys'
  },
  { 
    type: 'recent-submissions', 
    title: 'Recent Evaluations Log', 
    desc: 'A real-time stream of the latest completed survey submissions and stakeholder ratings.', 
    defaultSpan: 1,
    category: 'Submissions'
  },
  { 
    type: 'question-scores', 
    title: 'Top & Bottom Question Ratings', 
    desc: 'Highlights the single highest and lowest scoring questions to isolate performance gaps.', 
    defaultSpan: 1,
    category: 'Analytics'
  }
];

const DEFAULT_LAYOUT: DashboardWidget[] = [
  { id: 'widget-satisfaction', type: 'satisfaction-gauge', title: 'Top Performing Partner', gridSpan: 2 },
  { id: 'widget-volume', type: 'volume-tracker', title: 'Response Statistics Feed', gridSpan: 1 },
  { id: 'widget-comparison', type: 'group-comparison', title: 'Stakeholder Group Comparison', gridSpan: 1 },
  { id: 'widget-active-forms', type: 'active-forms', title: 'Published Survey Forms', gridSpan: 1 },
  { id: 'widget-recent', type: 'recent-submissions', title: 'Recent Evaluations Log', gridSpan: 1 }
];

// Helper colors
const categoryColors: Record<string, string> = {
  Courier: 'bg-blue-500',
  Supplier: 'bg-emerald-500',
  Subcontractor: 'bg-orange-500'
};

const badgeColors: Record<string, string> = {
  Courier: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200 border border-blue-200 dark:border-blue-800',
  Supplier: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800',
  Subcontractor: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200 border border-orange-200 dark:border-orange-800'
};

import { createPortal } from 'react-dom';

export function DashboardPage({
  responses = [],
  allResponses = [],
  historyResponses,
  dataScope = 'current',
  onChangeDataScope,
  partnerCompanies = [],
  isLoading,
  error,
  surveyTypeFilter = [],
  surveys = [],
  isAdmin = false,
  userEmail = ''
}: DashboardPageProps) {
  const effectiveHistoryResponses = historyResponses ?? allResponses;
  
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [draftWidgets, setDraftWidgets] = useState<DashboardWidget[]>([]);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [draggedWidgetId, setDraggedWidgetId] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState<'All' | 'Analytics' | 'Surveys' | 'Submissions'>('All');
  const [showConfigMenu, setShowConfigMenu] = useState<string | null>(null);
  const [headerPortalTarget, setHeaderPortalTarget] = useState<Element | null>(null);

  useEffect(() => {
    setHeaderPortalTarget(document.getElementById('shell-header-action'));
  }, []);

  // Load custom layout
  useEffect(() => {
    const saved = localStorage.getItem('survey_dashboard_widgets_v1');
    if (saved) {
      try {
        setWidgets(JSON.parse(saved));
      } catch (e) {
        setWidgets(DEFAULT_LAYOUT);
      }
    } else {
      setWidgets(DEFAULT_LAYOUT);
    }
  }, []);

  const activeWidgets = isCustomizing ? draftWidgets : widgets;

  const saveLayout = (newWidgets: DashboardWidget[]) => {
    setWidgets(newWidgets);
    localStorage.setItem('survey_dashboard_widgets_v1', JSON.stringify(newWidgets));
  };

  const startCustomize = () => {
    setDraftWidgets([...widgets]);
    setIsCustomizing(true);
  };

  const saveCustomize = () => {
    saveLayout(draftWidgets);
    setIsCustomizing(false);
  };

  const cancelCustomize = () => {
    setIsCustomizing(false);
  };

  // Add widget
  const handleAddWidget = (item: typeof ALL_WIDGET_CATALOG[0]) => {
    const newWidget: DashboardWidget = {
      id: `widget-${Date.now()}`,
      type: item.type,
      title: item.title,
      gridSpan: item.defaultSpan
    };
    const updated = [...activeWidgets, newWidget];
    if (isCustomizing) setDraftWidgets(updated);
    else saveLayout(updated);
    setIsAddOpen(false);
  };

  // Remove widget
  const handleRemoveWidget = (id: string) => {
    const updated = activeWidgets.filter(w => w.id !== id);
    if (isCustomizing) setDraftWidgets(updated);
    else saveLayout(updated);
  };

  // Resize widget (cycle through span width: 1 -> 2 -> 3 -> 1)
  const handleResizeWidget = (id: string) => {
    const updated = activeWidgets.map(w => {
      if (w.id === id) {
        const nextSpan: (1 | 2 | 3) = w.gridSpan === 1 ? 2 : w.gridSpan === 2 ? 3 : 1;
        return { ...w, gridSpan: nextSpan };
      }
      return w;
    });
    if (isCustomizing) setDraftWidgets(updated);
    else saveLayout(updated);
  };

  // Move widget position in array (left / right / up / down)
  const handleMoveWidget = (index: number, direction: 'prev' | 'next') => {
    if (direction === 'prev' && index === 0) return;
    if (direction === 'next' && index === activeWidgets.length - 1) return;

    const targetIndex = direction === 'prev' ? index - 1 : index + 1;
    const updated = [...activeWidgets];
    const temp = updated[index];
    updated[index] = updated[targetIndex];
    updated[targetIndex] = temp;
    if (isCustomizing) setDraftWidgets(updated);
    else saveLayout(updated);
  };

  // Drag and Drop support
  const handleDragStart = (e: React.DragEvent, id: string) => {
    if (!isCustomizing) return;
    setDraggedWidgetId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isCustomizing) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    if (!isCustomizing || !draggedWidgetId || draggedWidgetId === targetId) return;
    e.preventDefault();
    
    const draggedIndex = draftWidgets.findIndex(w => w.id === draggedWidgetId);
    const targetIndex = draftWidgets.findIndex(w => w.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    
    const newWidgets = [...draftWidgets];
    const draggedItem = newWidgets[draggedIndex];
    
    // Remove dragged item
    newWidgets.splice(draggedIndex, 1);
    // Insert at target index
    newWidgets.splice(targetIndex, 0, draggedItem);
    
    setDraftWidgets(newWidgets);
    setDraggedWidgetId(null);
  };

  // Reset to default
  const handleResetLayout = () => {
    if (isCustomizing) {
      setDraftWidgets([...DEFAULT_LAYOUT]);
    } else {
      saveLayout(DEFAULT_LAYOUT);
    }
  };
  const assignedSurveyTypes = useMemo(() => {
    const set = new Set<SurveyType>();
    surveys.forEach((survey: any) => {
      if (survey.status !== 'Archived') set.add(survey.surveyType);
    });
    return set;
  }, [surveys]);

  const todoStats = useMemo(() => {
    const categories: SurveyType[] = ['Courier', 'Supplier', 'Subcontractor'];
    return categories.map(cat => {
      const hasAssignedForm = assignedSurveyTypes.has(cat);

      // Union of companies this category's active, non-archived survey(s)
      // are actually configured to evaluate (respects each survey's
      // "Modify Companies to Evaluate" selection, always live against the
      // current Partner Registry), so the denominator normalizes to 100%
      // against the correct set of companies rather than every company of
      // that type in the system.
      const companyIds = new Map<string, true>();
      surveys.forEach((survey: any) => {
        if (survey.status === 'Archived' || survey.surveyType !== cat) return;
        getSurveyEvaluationCompanies(survey, partnerCompanies).forEach((c) => companyIds.set(c.id, true));
      });
      const total = companyIds.size;
      
      // Get unique companies of this category that the current user has evaluated
      const userResponses = allResponses.filter(r => 
        r.respondentEmail === userEmail && 
        r.surveyType === cat
      );
      const evaluatedCompanies = new Set(userResponses.map(r => r.company));
      const answered = evaluatedCompanies.size;
      
      const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
      
      return {
        category: cat,
        total,
        answered,
        pct,
        hasAssignedForm
      };
    });
  }, [allResponses, surveys, partnerCompanies, userEmail, assignedSurveyTypes]);

  // ----------------------------------------------------
  // COMPUTED STATS FOR WIDGETS
  // ----------------------------------------------------
  
  // 1. Partner Company Averages (to find the Top Performing Partner)
  const companyAverages = useMemo(() => {
    if (!effectiveHistoryResponses.length || !partnerCompanies.length) return [];

    const companyMap: Record<string, { name: string; sum: number; count: number; type: string }> = {};

    const typeMap = new Map<string, string>();
    partnerCompanies.forEach((c) => typeMap.set(c.name, c.type));

    submissionScores(effectiveHistoryResponses).forEach((submission) => {
      if (!companyMap[submission.company]) {
        const type = typeMap.get(submission.company) || submission.surveyType;
        companyMap[submission.company] = { name: submission.company, sum: 0, count: 0, type };
      }
      companyMap[submission.company].sum += submission.score;
      companyMap[submission.company].count += 1;
    });

    partnerCompanies.forEach((c) => {
      if (!companyMap[c.name]) {
        companyMap[c.name] = { name: c.name, sum: 0, count: 0, type: c.type };
      }
    });

    const evaluated = Object.values(companyMap)
      .map((c) => {
        const average = c.count > 0 ? c.sum / c.count : 0;
        return {
          name: c.name,
          average: (average / 20), // out of 5
          scorePercentage: average, // out of 100
          count: c.count,
          type: c.type,
        };
      })
      .filter((c) => c.count > 0);

    // Rank by a volume-weighted score, not the raw average, so a company
    // with a single (possibly lucky) evaluation can't outrank one with many
    // - see computeRankScore in analytics.ts.
    const peers = evaluated.map((c) => ({ score: c.scorePercentage, count: c.count }));
    return evaluated
      .map((c) => ({ ...c, rankScore: computeRankScore(c.scorePercentage, c.count, peers) }))
      .sort((a, b) => b.rankScore - a.rankScore);
  }, [effectiveHistoryResponses, partnerCompanies]);

  const topPartner = useMemo(() => {
    return companyAverages[0] || null;
  }, [companyAverages]);

  // "Active Partners" counts accredited BP Codes the way the Master List's
  // Category Summary does - per branch, NT separate - not merged companies.
  // A company holding both an NT and a non-NT BP Code counts as two here.
  const accreditedBranchTotal = useMemo(
    () => computeCategoryRankSummary(partnerCompanies).total,
    [partnerCompanies]
  );

  // 2. Stakeholder Groups Comparison Averages
  const groupAverages = useMemo(() => {
    const counts = { Courier: 0, Supplier: 0, Subcontractor: 0 };
    const averages = { Courier: 0, Supplier: 0, Subcontractor: 0 };

    const contractorResponses = effectiveHistoryResponses.filter(r => r.surveyType === 'Courier');
    const supplierResponses = effectiveHistoryResponses.filter(r => r.surveyType === 'Supplier');
    const subcontractorResponses = effectiveHistoryResponses.filter(r => r.surveyType === 'Subcontractor');

    counts.Courier = submissionCount(contractorResponses);
    counts.Supplier = submissionCount(supplierResponses);
    counts.Subcontractor = submissionCount(subcontractorResponses);

    averages.Courier = averageRating(contractorResponses);
    averages.Supplier = averageRating(supplierResponses);
    averages.Subcontractor = averageRating(subcontractorResponses);

    return {
      Courier: averages.Courier,
      Supplier: averages.Supplier,
      Subcontractor: averages.Subcontractor,
      counts
    };
  }, [effectiveHistoryResponses]);

  // 3. Question Performance rankings
  const questionAverages = useMemo(() => {
    const list = questionPerformance(effectiveHistoryResponses);
    return {
      top: list[0] ? { text: list[0].question, average: list[0].average } : null,
      bottom: list[list.length - 1] ? { text: list[list.length - 1].question, average: list[list.length - 1].average } : null
    };
  }, [effectiveHistoryResponses]);

  // 4. Submissions Feed
  const recentSubmissions = useMemo(() => {
    const submissions = submissionScores(allResponses);
    return [...submissions]
      .sort((a, b) => new Date(b.submissionDate).getTime() - new Date(a.submissionDate).getTime())
      .slice(0, 5);
  }, [allResponses]);

  // Catalog filtered widgets
  const filteredCatalog = useMemo(() => {
    if (catalogTab === 'All') return ALL_WIDGET_CATALOG;
    return ALL_WIDGET_CATALOG.filter(w => w.category === catalogTab);
  }, [catalogTab]);

  return (
    <div className="space-y-6">
      
      {/* ----------------------------------------------------
          DASHBOARD HEADER & CONTROL BAR
          ---------------------------------------------------- */}
      {headerPortalTarget && createPortal(
        <div className="flex flex-wrap items-center gap-2.5 shrink-0 justify-end w-full sm:w-auto">
          {onChangeDataScope && (
            <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-1" title="Choose whether stats reflect only the current period or every archived period combined">
              {(['current', 'all-time'] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => onChangeDataScope(scope)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                    dataScope === scope
                      ? 'bg-[#0063a9] text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {scope === 'current' ? 'Current Period' : 'All-Time'}
                </button>
              ))}
            </div>
          )}
          {isCustomizing ? (
            <>
              <button
                onClick={handleResetLayout}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900 transition-all shadow-xs"
                title="Reset to default workspace"
                type="button"
              >
                <RotateCcw size={14} />
                Reset
              </button>
              <button
                onClick={cancelCustomize}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900 transition-all shadow-xs"
                type="button"
              >
                Cancel
              </button>
              <button
                onClick={() => setIsAddOpen(true)}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-800/60 text-blue-700 dark:text-blue-300 px-4 py-2 text-xs font-semibold transition-all duration-200"
                type="button"
              >
                <Plus size={14} />
                Add
              </button>
              <button
                onClick={saveCustomize}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-6 py-2 text-xs font-semibold text-white shadow-md transition-all duration-200 hover:scale-[1.02]"
                type="button"
              >
                <CheckCircle2 size={15} />
                Save Changes
              </button>
            </>
          ) : (
            <button
              onClick={startCustomize}
              className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[#0063a9] hover:bg-[#00528c] px-6 py-2 text-xs font-semibold text-white shadow-md transition-all duration-200 hover:scale-[1.02]"
              type="button"
            >
              <LayoutGrid size={15} />
              Customize Layout
            </button>
          )}
        </div>,
        headerPortalTarget
      )}

      {/* ----------------------------------------------------
          TO-DO PROGRESS FOR NON-ADMINS
          ---------------------------------------------------- */}
      {!isAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm mb-6">
          <div className="flex items-center gap-2.5 mb-6">
            <span className="p-2 rounded-xl bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400">
              <CheckCircle2 size={20} className="animate-pulse" />
            </span>
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-white">Evaluation Progress</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Complete evaluations for all registered partner companies below.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {todoStats.map(({ category, total, answered, pct, hasAssignedForm }) => {
              // Color mapping
              const strokeColor = category === 'Courier' 
                ? 'stroke-blue-500' 
                : category === 'Supplier' 
                  ? 'stroke-emerald-500' 
                  : 'stroke-orange-500';
              const textColor = category === 'Courier'
                ? 'text-blue-600 dark:text-blue-400'
                : category === 'Supplier'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-orange-600 dark:text-orange-400';

              // Half-circle (semicircle) gauge geometry.
              // Path starts at the left (10,90) and sweeps clockwise over the top to the
              // right (190,90). pathLength=100 lets us express progress directly as a 0-100
              // dash offset, so the colored arc always begins filling from the left (0%)
              // and grows rightward/clockwise as pct increases toward 100%.
              const gaugePath = 'M10 90 A90 90 0 0 1 190 90';

              if (!hasAssignedForm) {
                return (
                  <div key={category} className="flex flex-col items-center justify-center p-7 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800/80 bg-slate-50/20 dark:bg-slate-950/20 shadow-2xs min-h-[220px]">
                    <span className="p-3 rounded-full bg-slate-100 dark:bg-slate-900 text-slate-400 dark:text-slate-600 mb-3">
                      <ClipboardList size={22} />
                    </span>
                    <p className="text-sm font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 text-center">
                      {category}
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-400 dark:text-slate-500 text-center">
                      No Task Yet
                    </p>
                    <p className="mt-1 text-[10px] font-medium text-slate-400 dark:text-slate-600 text-center">
                      No {category.toLowerCase()} survey form has been assigned to you.
                    </p>
                  </div>
                );
              }

              return (
                <div key={category} className="flex flex-col items-center p-7 rounded-2xl border border-slate-100 dark:border-slate-800/80 bg-slate-50/20 dark:bg-slate-950/20 shadow-2xs">
                  {/* Half-circle progress gauge with percentage nested inside the arc */}
                  <div className="relative w-full max-w-[260px]">
                    <svg viewBox="0 0 200 100" className="w-full h-auto overflow-visible">
                      <path
                        d={gaugePath}
                        fill="none"
                        className="stroke-slate-100 dark:stroke-slate-800"
                        strokeWidth="18"
                        strokeLinecap="round"
                      />
                      <path
                        d={gaugePath}
                        fill="none"
                        className={strokeColor}
                        strokeWidth="18"
                        strokeLinecap="round"
                        pathLength={100}
                        strokeDasharray={`${pct} 200`}
                        style={{ transition: 'stroke-dasharray 0.6s ease' }}
                      />
                    </svg>
                    <div className="absolute inset-x-0 bottom-[22%] flex justify-center">
                      <span className={`text-3xl font-extrabold leading-none ${textColor}`}>
                        {pct}%
                      </span>
                    </div>
                  </div>

                  {/* Category label, centered below the gauge */}
                  <p className="mt-2 text-sm font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 text-center">
                    {category}
                  </p>

                  {/* Companies evaluated subtext, centered */}
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 text-center">
                    {answered}/{total} Companies Evaluated
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------
          ACTIVE WIDGETS GRID
          ---------------------------------------------------- */}
      {activeWidgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[360px] text-center p-8 bg-white dark:bg-slate-900 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800">
          <div className="w-16 h-16 bg-blue-50 dark:bg-blue-950/20 rounded-full flex items-center justify-center mb-4 text-blue-500">
            <Sparkles size={32} />
          </div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">Your Workspace is Empty</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-sm">
            All widgets have been removed. Click the button below to start pinning satisfaction gauges, response logs, and active charts to your feed!
          </p>
          <button
            onClick={() => setIsAddOpen(true)}
            className="primary-button mt-5 px-5 py-2 rounded-xl text-xs font-semibold shadow-md"
            type="button"
          >
            + Create New Widget
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence mode="popLayout">
            {activeWidgets.map((widget, index) => {
              // Determine grid span class
              const spanClass = 
                widget.gridSpan === 3 
                  ? 'col-span-1 md:col-span-2 lg:col-span-3' 
                  : widget.gridSpan === 2 
                    ? 'col-span-1 md:col-span-2' 
                    : 'col-span-1';

              return (
                <motion.div
                  key={widget.id}
                  layout
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.25 }}
                  draggable={isCustomizing}
                  onDragStart={(e: React.DragEvent) => handleDragStart(e, widget.id)}
                  onDragOver={handleDragOver}
                  onDrop={(e: React.DragEvent) => handleDrop(e, widget.id)}
                  className={`${spanClass} flex flex-col bg-white dark:bg-slate-950 rounded-2xl border ${isCustomizing ? 'border-blue-300 dark:border-blue-700/50 cursor-grab hover:border-blue-400 dark:hover:border-blue-500 shadow-md ring-2 ring-blue-500/20' : 'border-slate-200/90 dark:border-slate-800 shadow-sm'} relative group overflow-visible transition-all`}
                >
                  
                  {/* Widget Card Header */}
                  <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-900/30 rounded-t-2xl">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-100 truncate" title={widget.title}>
                        {widget.title}
                      </h4>
                    </div>

                    {/* Widget Operations Toolbar */}
                    {isCustomizing && (
                      <div className="flex items-center gap-1 bg-white dark:bg-slate-900 rounded-lg p-0.5 border border-slate-200/60 dark:border-slate-800 shadow-2xs shrink-0">
                        {/* Move Left / Prev */}
                        <button
                          onClick={() => handleMoveWidget(index, 'prev')}
                          disabled={index === 0}
                          className="p-1 rounded text-slate-400 dark:text-slate-550 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
                          title="Move Up/Left"
                          type="button"
                        >
                          <ChevronLeft size={13} />
                        </button>

                        {/* Move Right / Next */}
                        <button
                          onClick={() => handleMoveWidget(index, 'next')}
                          disabled={index === activeWidgets.length - 1}
                          className="p-1 rounded text-slate-400 dark:text-slate-550 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
                          title="Move Down/Right"
                          type="button"
                        >
                          <ChevronRight size={13} />
                        </button>

                        {/* Resize Width */}
                        <button
                          onClick={() => handleResizeWidget(widget.id)}
                          className="p-1 rounded text-slate-400 dark:text-slate-550 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title={`Resize Widget (Current: ${widget.gridSpan === 1 ? '1/3' : widget.gridSpan === 2 ? '2/3' : 'Full'} Width)`}
                          type="button"
                        >
                          {widget.gridSpan === 1 ? <Maximize2 size={11} /> : <Minimize2 size={11} />}
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => handleRemoveWidget(widget.id)}
                          className="p-1 rounded text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                          title="Delete Widget"
                          type="button"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Widget Card Body */}
                  <div className="p-5 flex-1 flex flex-col justify-center min-h-[160px]">
                    {widget.type === 'satisfaction-gauge' && (
                      <div className="space-y-4">
                        {topPartner ? (
                          <div className="flex flex-col sm:flex-row items-center gap-5 justify-between">
                            {/* Dial */}
                            <div className="relative flex items-center justify-center w-24 h-24 shrink-0">
                              <svg className="w-full h-full transform -rotate-90">
                                <circle
                                  cx="48"
                                  cy="48"
                                  r="36"
                                  className="stroke-slate-100 dark:stroke-slate-900 fill-none"
                                  strokeWidth="6"
                                />
                                <circle
                                  cx="48"
                                  cy="48"
                                  r="36"
                                  className="stroke-emerald-500 fill-none"
                                  strokeWidth="6"
                                  strokeDasharray="226.1"
                                  strokeDashoffset={226.1 - (226.1 * topPartner.scorePercentage) / 100}
                                  strokeLinecap="round"
                                />
                              </svg>
                              <div className="absolute flex flex-col items-center">
                                <span className="text-lg font-bold text-slate-800 dark:text-slate-200">
                                  {Math.round(topPartner.scorePercentage)}%
                                </span>
                              </div>
                            </div>

                            {/* Details */}
                            <div className="flex-1 text-center sm:text-left">
                              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-md inline-block">
                                {topPartner.type} Top Rank
                              </span>
                              <h5 className="font-bold text-slate-800 dark:text-slate-100 text-xl mt-1.5 truncate max-w-[280px]">
                                {topPartner.name}
                              </h5>
                              <p className="text-xs text-slate-400 mt-1 leading-snug">
                                Acclaimed leader across {topPartner.count} employee feedback surveys.
                              </p>
                              <div className="mt-3 flex items-center gap-4 text-[11px] font-semibold text-slate-500">
                                <span>Rating: {formatCompositeScore(topPartner.type as SurveyType, topPartner.scorePercentage).text}</span>
                                <span>•</span>
                                <span>{topPartner.count} reviews</span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-center text-slate-400 text-xs py-4">
                            No active partner reviews registered yet.
                          </div>
                        )}
                      </div>
                    )}

                    {widget.type === 'volume-tracker' && (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-slate-50/50 dark:bg-slate-900/40 p-3.5 rounded-xl border border-slate-100 dark:border-slate-800">
                          <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Total Feedback</span>
                          <span className="text-2xl font-light text-slate-800 dark:text-white mt-1 block">
                            {submissionCount(effectiveHistoryResponses)}
                          </span>
                          <span className="text-[10px] text-blue-500 mt-1 block font-medium">Submissions log</span>
                        </div>

                        <div className="bg-slate-50/50 dark:bg-slate-900/40 p-3.5 rounded-xl border border-slate-100 dark:border-slate-800">
                          <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">Active Partners</span>
                          <span className="text-2xl font-light text-slate-800 dark:text-white mt-1 block">
                            {accreditedBranchTotal}
                          </span>
                          <span className="text-[10px] text-emerald-500 mt-1 block font-medium">Accredited BP Codes</span>
                        </div>
                      </div>
                    )}

                    {widget.type === 'group-comparison' && (() => {
                      // Group scores tend to cluster tightly in a high range (e.g. 85-95),
                      // so a raw 0-100 width makes every bar look almost identical and full.
                      // Rescale against a floor just below the lowest group score so the
                      // relative differences between groups are actually visible.
                      const groupValues = [groupAverages.Courier, groupAverages.Supplier, groupAverages.Subcontractor]
                        .filter((v): v is number => typeof v === 'number' && !isNaN(v));
                      const minGroupValue = groupValues.length ? Math.min(...groupValues) : 0;
                      const barFloor = Math.max(0, Math.floor(minGroupValue / 10) * 10 - 10);
                      const normalizedWidth = (value?: number) => {
                        if (!value) return 0;
                        return Math.max(4, ((value - barFloor) / (100 - barFloor)) * 100);
                      };

                      return (
                        <div className="space-y-6 w-full">
                          {/* Courier Group Row */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-sm font-medium text-slate-600 dark:text-slate-400">
                              <span>Couriers ({groupAverages.counts.Courier} submissions)</span>
                              <span className="font-bold text-slate-800 dark:text-slate-200">
                                {groupAverages.Courier ? `${Math.round(groupAverages.Courier)} / 100` : 'N/A'}
                              </span>
                            </div>
                            <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                                style={{ width: `${normalizedWidth(groupAverages.Courier)}%` }}
                              />
                            </div>
                          </div>

                          {/* Supplier Group Row */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-sm font-medium text-slate-600 dark:text-slate-400">
                              <span>Suppliers ({groupAverages.counts.Supplier} submissions)</span>
                              <span className="font-bold text-slate-800 dark:text-slate-200">
                                {groupAverages.Supplier ? `${Math.round(groupAverages.Supplier)} / 100` : 'N/A'}
                              </span>
                            </div>
                            <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                                style={{ width: `${normalizedWidth(groupAverages.Supplier)}%` }}
                              />
                            </div>
                          </div>

                          {/* Subcontractor Group Row */}
                          <div className="space-y-1.5">
                            <div className="flex justify-between text-sm font-medium text-slate-600 dark:text-slate-400">
                              <span>Subcontractors ({groupAverages.counts.Subcontractor} submissions)</span>
                              <span className="font-bold text-slate-800 dark:text-slate-200">
                                {groupAverages.Subcontractor ? formatCompositeScore('Subcontractor', groupAverages.Subcontractor).text : 'N/A'}
                              </span>
                            </div>
                            <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-orange-500 rounded-full transition-all duration-500"
                                style={{ width: `${normalizedWidth(groupAverages.Subcontractor)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {widget.type === 'active-forms' && (
                      <div className="space-y-4">
                        {surveys.length === 0 ? (
                          <div className="text-center text-slate-400 text-xs py-4">
                            No published survey questionnaires are available.
                          </div>
                        ) : (
                          surveys.slice(0, 3).map((survey) => {
                            // Responses aren't tagged with the specific form's ID, so match on
                            // survey type (as the rest of the app does) and count unique
                            // respondent submissions rather than raw per-question answer rows.
                            const count = submissionCount(allResponses.filter(r => r.surveyType === survey.surveyType));
                            return (
                              <div key={survey.id} className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50/50 dark:bg-slate-900/20 border border-slate-100 dark:border-slate-800 text-sm">
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="font-bold text-slate-800 dark:text-slate-200 truncate">{survey.title}</p>
                                  <p className="text-xs text-slate-400 mt-1">Due: {survey.deadlineDate || 'No close date'}</p>
                                </div>
                                <span className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 font-bold text-blue-600 dark:text-blue-400 text-xs">
                                  {count} respondents
                                </span>
                              </div>
                            );
                          })
                        )}
                        {surveys.length > 3 && (
                          <p className="text-xs text-center text-slate-400 italic font-medium pt-1">
                            + {surveys.length - 3} more forms in the active registry.
                          </p>
                        )}
                      </div>
                    )}

                    {widget.type === 'recent-submissions' && (
                      <div className="space-y-2">
                        {recentSubmissions.length === 0 ? (
                          <div className="text-center text-slate-400 text-xs py-4">
                            No survey responses are available.
                          </div>
                        ) : (
                          recentSubmissions.map((resp, sIdx) => {
                            return (
                              <div key={sIdx} className="flex items-center justify-between text-xs py-1.5 border-b border-dashed border-slate-100 dark:border-slate-800/60 last:border-0">
                                <div className="min-w-0 flex-1 pr-2">
                                  <span className={`text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded ${badgeColors[resp.surveyType] || 'bg-slate-100 text-slate-800'}`}>
                                    {resp.surveyType}
                                  </span>
                                  <p className="font-semibold text-slate-700 dark:text-slate-300 truncate mt-1">
                                    {resp.company}
                                  </p>
                                </div>
                                <span className="shrink-0 font-bold text-slate-900 dark:text-white">
                                  {formatCompositeScore(resp.surveyType, resp.score).text}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {widget.type === 'question-scores' && (
                      <div className="space-y-3">
                        {questionAverages.top ? (
                          <div className="space-y-2">
                            <div className="p-2.5 rounded-xl border border-emerald-100 dark:border-emerald-900/20 bg-emerald-50/10">
                              <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 block">Highest Rated Query</span>
                              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-1 line-clamp-1">
                                "{questionAverages.top.text}"
                              </p>
                              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-1 block">
                                Average: {Math.round(questionAverages.top.average)} / 100
                              </span>
                            </div>

                            {questionAverages.bottom && (
                              <div className="p-2.5 rounded-xl border border-rose-100 dark:border-rose-900/20 bg-rose-50/10">
                                <span className="text-[9px] font-bold uppercase tracking-wider text-rose-500 block">Lowest Rated Query</span>
                                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-1 line-clamp-1">
                                  "{questionAverages.bottom.text}"
                                </p>
                                <span className="text-[10px] font-bold text-rose-500 mt-1 block">
                                  Average: {Math.round(questionAverages.bottom.average)} / 100
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-center text-slate-400 text-xs py-4">
                            Submit evaluations to populate query averages.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ----------------------------------------------------
          ADD WIDGET MODAL DIALOG
          ---------------------------------------------------- */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4 mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Workspace Catalog</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Select a widget card to place onto your tailored metrics feed.</p>
              </div>
              <button 
                onClick={() => setIsAddOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                type="button"
              >
                ✕
              </button>
            </div>

            {/* Catalog Categories */}
            <div className="flex flex-wrap gap-2 mb-5">
              {(['All', 'Analytics', 'Surveys', 'Submissions'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setCatalogTab(tab)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                    catalogTab === tab 
                      ? 'bg-[#0063a9] text-white' 
                      : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                  type="button"
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Widget Items Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[380px] overflow-y-auto pr-1">
              {filteredCatalog.map(item => {
                // Check if already in dashboard
                const exists = widgets.some(w => w.type === item.type);

                return (
                  <div 
                    key={item.type}
                    className="flex flex-col justify-between p-4 rounded-xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/20 hover:border-blue-500/50 dark:hover:border-blue-500/30 transition-all group"
                  >
                    <div>
                      <div className="flex items-center gap-1.5 justify-between">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{item.title}</span>
                        <span className="text-[9px] uppercase font-extrabold tracking-wider bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-400 dark:text-slate-500">
                          {item.category}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">
                        {item.desc}
                      </p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-slate-400">
                        Default width: {item.defaultSpan === 3 ? 'Full Width' : item.defaultSpan === 2 ? 'Two-Thirds' : 'One-Third'}
                      </span>
                      <button
                        onClick={() => handleAddWidget(item)}
                        className="inline-flex items-center justify-center gap-1 cursor-pointer rounded-lg bg-[#0063a9]/10 hover:bg-[#0063a9] text-[#0063a9] hover:text-white px-2.5 py-1.5 text-[11px] font-bold transition-all duration-150"
                        type="button"
                      >
                        <Plus size={12} />
                        Add Widget {exists && <span className="text-[9px] font-medium opacity-75">(Extra)</span>}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-4 mt-6 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => setIsAddOpen(false)}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer transition-all"
                type="button"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}

    </div>
  );
}
