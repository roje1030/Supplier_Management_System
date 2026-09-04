#!/usr/bin/env node

/**
 * Supabase CSV Import Script (ES Module Version)
 * Imports supplier data and evaluation responses to your Supabase database
 * 
 * Setup:
 * 1. npm install @supabase/supabase-js papaparse dotenv
 * 2. Create .env file with SUPABASE_URL and SUPABASE_KEY
 * 3. node import-to-supabase.js
 */

import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_KEY must be set in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper function to parse CSV file
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.readFileSync(filePath, 'utf8');
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (error) => reject(error),
    });
  });
}

// ============================================================================
// PART 1: IMPORT PARTNER COMPANIES (from suppliers.csv)
// ============================================================================

async function importPartnerCompanies(filePath) {
  console.log('\n📋 Importing Partner Companies...');
  
  try {
    const data = await parseCSV(filePath);
    console.log(`   Found ${data.length} records`);

    let successCount = 0;
    let errorCount = 0;

    for (const row of data) {
      try {
        // Map CSV columns to partner_companies table
        const company = {
          id: row['BP Code']?.trim() || `auto-${Date.now()}-${Math.random()}`,
          name: row['BP Name']?.trim() || 'Unknown',
          type: normalizeCompanyType(row['Category']),
          supplier_origin: normalizeOrigin(row['Category']),
          email: row['E-Mail']?.trim() || null,
          affiliation: row['Conglomerate']?.trim() || null,
          registered_at: parseDate(row['Date Accredited']),
          is_archived: row['Status']?.toLowerCase().includes('archived') || row['Status']?.toLowerCase().includes('outdated') || false,
          accreditation_status: parseAccreditationStatus(row),
          branches: [{
            name: row['BP Name'],
            address: row['BP Address'],
            contact_person: row['Contact Person'] || null,
            phone: row['Mobile Phone'] || null,
          }],
        };

        // Upsert (insert or update if exists)
        const { error } = await supabase
          .from('partner_companies')
          .upsert(company, { onConflict: 'id' });

        if (error) {
          console.error(`   ⚠️  Row error: ${company.name} - ${error.message}`);
          errorCount++;
        } else {
          successCount++;
        }
      } catch (err) {
        console.error(`   ⚠️  Parse error: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`   ✅ Imported ${successCount} companies (${errorCount} errors)`);
    return { successCount, errorCount };
  } catch (error) {
    console.error(`❌ Error importing partner companies: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// PART 2: IMPORT SURVEY RESPONSES (from evaluation forms)
// ============================================================================

async function importSurveyResponses(filePath, surveyType) {
  console.log(`\n📊 Importing ${surveyType} Evaluation Responses...`);
  
  try {
    const data = await parseCSV(filePath);
    console.log(`   Found ${data.length} records`);

    let successCount = 0;
    let errorCount = 0;

    for (const row of data) {
      try {
        // Extract rating questions (all columns that contain numeric ratings)
        const questions = extractRatingQuestions(row, surveyType);

        // Create one row per question answered (same structure as schema)
        for (let idx = 0; idx < questions.length; idx++) {
          const q = questions[idx];

          const response = {
            response_id: `${surveyType}-${row['ID']}-${row['Email']}`,
            survey_type: surveyType,
            respondent_type: row['Designation:']?.trim() || 'Unknown',
            start_time: parseDateTime(row['Start time']),
            submission_date: parseDateTime(row['Completion time']) || new Date().toISOString(),
            company: row[`${surveyType} Name:`]?.trim() || row['Supplier Name:']?.trim() || 'Unknown',
            department: row['Department:']?.trim() || null,
            address: row[`${surveyType} Address:`]?.trim() || null,
            question_id: `${q.id}-${row['ID']}`,
            question_number: idx + 1,
            question: q.question,
            question_category: q.category,
            rating_value: q.ratingValue,
            rating_is_na: q.isNA,
            comment: q.comment || null,
            respondent_email: row['Email']?.trim().toLowerCase() || null,
          };

          const { error } = await supabase
            .from('survey_responses')
            .upsert(response, { 
              onConflict: 'response_id,question_id' 
            });

          if (error) {
            console.error(`   ⚠️  Row error: ${row['ID']} - ${error.message}`);
            errorCount++;
          } else {
            successCount++;
          }
        }
      } catch (err) {
        console.error(`   ⚠️  Parse error: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`   ✅ Imported ${successCount} responses (${errorCount} errors)`);
    return { successCount, errorCount };
  } catch (error) {
    console.error(`❌ Error importing ${surveyType} responses: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function normalizeCompanyType(category) {
  if (!category) return 'Uncategorized';
  const cat = category.toLowerCase();
  
  if (cat.includes('courier')) return 'Courier';
  if (cat.includes('supplier')) return 'Supplier';
  if (cat.includes('subcontractor')) return 'Subcontractor';
  return 'Uncategorized';
}

function normalizeOrigin(category) {
  if (!category) return null;
  const cat = category.toLowerCase();
  
  if (cat.includes('foreign')) return 'Foreign';
  if (cat.includes('local')) return 'Local';
  return null;
}

function parseDate(dateStr) {
  if (!dateStr || dateStr.toLowerCase() === 'n/a') return null;
  
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed) ? null : parsed.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

function parseDateTime(dateStr) {
  if (!dateStr) return null;
  
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

function parseAccreditationStatus(row) {
  // Check if row has accreditation documents
  const hasAccreditation = 
    row['Confidentiality and Non-Disclosure Agreement'] === 'Yes' &&
    row['Letter of Accreditation'] === 'Yes';
  
  return hasAccreditation ? 'Accredited' : 'Unaccredited';
}

function extractRatingQuestions(row, surveyType) {
  const questions = [];
  const excludeColumns = new Set([
    'ID', 'Start time', 'Completion time', 'Email', 'Name', 'Last modified time',
    'Designation:', 'Department:', `${surveyType} Name:`, `${surveyType} Address:`,
    'Period Covered:', 'Supplier Name:',
  ]);

  let category = '';
  let questionId = 1;

  Object.entries(row).forEach(([key, value]) => {
    if (excludeColumns.has(key) || !key.trim()) return;

    // Detect category from Remarks columns
    if (key.toLowerCase().includes('remarks')) {
      category = key.replace(/Remarks/i, '').trim();
      return;
    }

    // Parse rating value
    let ratingValue = null;
    let isNA = false;
    let comment = null;

    const val = String(value).trim();

    if (val.toLowerCase().includes('n/a') || val === '' || val === 'none') {
      isNA = true;
    } else if (/^\d+$/.test(val)) {
      ratingValue = parseInt(val, 10);
    } else if (val.length > 0 && !val.toLowerCase().includes('remarks')) {
      // Long text responses go to comment
      comment = val;
    }

    if (ratingValue !== null || isNA || comment) {
      questions.push({
        id: `q-${questionId}`,
        question: key,
        category: category || 'General',
        ratingValue,
        isNA,
        comment,
      });
      questionId++;
    }
  });

  return questions;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('🚀 Starting Supabase Import...');
  console.log(`Connected to: ${supabaseUrl}\n`);

  try {
    // Define file paths (adjust to your file locations)
    const files = {
      suppliers: './suppliers.csv',
      supplierEval: './Microgenesis_Supplier_Evaluation_Form.csv',
      courierEval: './Microgenesis_Courier_Evaluation_Form.csv',
      subcontractorEval: './Microgenesis_Subcontractor_Evaluation_Form.csv',
    };

    // Check which files exist
    const existingFiles = {};
    Object.entries(files).forEach(([key, filePath]) => {
      if (fs.existsSync(filePath)) {
        existingFiles[key] = filePath;
      } else {
        console.warn(`⚠️  File not found: ${filePath}`);
      }
    });

    // Import data
    let totalSuccess = 0;
    let totalErrors = 0;

    if (existingFiles.suppliers) {
      const result = await importPartnerCompanies(existingFiles.suppliers);
      totalSuccess += result.successCount;
      totalErrors += result.errorCount;
    }

    if (existingFiles.supplierEval) {
      const result = await importSurveyResponses(existingFiles.supplierEval, 'Supplier');
      totalSuccess += result.successCount;
      totalErrors += result.errorCount;
    }

    if (existingFiles.courierEval) {
      const result = await importSurveyResponses(existingFiles.courierEval, 'Courier');
      totalSuccess += result.successCount;
      totalErrors += result.errorCount;
    }

    if (existingFiles.subcontractorEval) {
      const result = await importSurveyResponses(existingFiles.subcontractorEval, 'Subcontractor');
      totalSuccess += result.successCount;
      totalErrors += result.errorCount;
    }

    console.log('\n' + '='.repeat(50));
    console.log(`✅ Import Complete!`);
    console.log(`   Total Imported: ${totalSuccess}`);
    console.log(`   Total Errors: ${totalErrors}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
