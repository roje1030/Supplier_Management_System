import { supabase, isSupabaseConfigured } from './supabaseClient';
import { Rating, SurveyResponse } from '../types/survey';

function mapRating(rating: Rating): { rating_value: number | null; rating_is_na: boolean } {
  if (rating === 'N/A') return { rating_value: null, rating_is_na: true };
  return { rating_value: rating, rating_is_na: false };
}

function toRow(response: SurveyResponse) {
  const { rating_value, rating_is_na } = mapRating(response.rating);
  return {
    response_id: response.responseId,
    survey_type: response.surveyType,
    respondent_type: response.respondentType,
    start_time: response.startTime ?? null,
    submission_date: response.submissionDate,
    company: response.company,
    department: response.department ?? null,
    address: response.address ?? null,
    question_id: response.questionId,
    question_number: response.questionNumber,
    question: response.question,
    question_category: response.questionCategory,
    rating_value,
    rating_is_na,
    comment: response.comment ?? null,
    respondent_email: response.respondentEmail ?? null,
    archived: response.archived ?? false,
    archived_at: response.archivedAt ?? null,
    archived_by_survey_id: response.archivedBySurveyId ?? null,
    archived_by_survey_title: response.archivedBySurveyTitle ?? null,
    series_id: response.seriesId ?? null,
  };
}

// Fire-and-forget: localStorage stays the source of truth the rest of the
// app reads from until the read side is migrated too, so a Supabase failure
// here (unconfigured project, schema not applied yet, RLS mismatch) should
// never block or break the existing submit flow - just log it.
export async function insertSurveyResponses(responses: SurveyResponse[]): Promise<void> {
  if (!isSupabaseConfigured || responses.length === 0) return;
  const { error } = await supabase.from('survey_responses').insert(responses.map(toRow));
  if (error) {
    console.error('Supabase: failed to save survey response(s)', error);
  }
}

// Fetch all survey responses from Supabase
export async function fetchSurveyResponses(): Promise<SurveyResponse[]> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured.');
  }

  const { data, error } = await supabase
    .from('survey_responses')
    .select('*')
    .order('submission_date', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch survey responses: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  // Map Supabase columns back to SurveyResponse type
  return data.map((row: any): SurveyResponse => ({
    responseId: row.response_id,
    surveyType: row.survey_type,
    respondentType: row.respondent_type,
    startTime: row.start_time ?? undefined,
    submissionDate: row.submission_date,
    company: row.company,
    department: row.department ?? undefined,
    address: row.address ?? undefined,
    questionId: row.question_id,
    questionNumber: row.question_number,
    question: row.question,
    questionCategory: row.question_category,
    rating: row.rating_is_na ? 'N/A' : (row.rating_value as Rating),
    comment: row.comment ?? undefined,
    respondentEmail: row.respondent_email ?? undefined,
    archived: row.archived ?? false,
    archivedAt: row.archived_at ?? undefined,
    archivedBySurveyId: row.archived_by_survey_id ?? undefined,
    archivedBySurveyTitle: row.archived_by_survey_title ?? undefined,
    seriesId: row.series_id ?? undefined,
  }));
}