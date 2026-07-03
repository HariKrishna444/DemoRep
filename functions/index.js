/**
 * STEP 1 — SECURE CODE EXECUTION VIA SERVERLESS CLOUD FUNCTIONS
 * ─────────────────────────────────────────────────────────────
 * All grading now happens here, not in the browser.
 *
 *  - The client (CodingHub.html) calls this as a Firebase HTTPS callable:
 *        functionsRef.httpsCallable('gradeSubmission')({ questionId, code, language })
 *  - This function reads the authoritative test cases from
 *    questions_private/{questionId} using the Admin SDK, which bypasses
 *    Firestore security rules entirely — there is nothing for a student's
 *    browser to "get denied" reading, because the browser never asks.
 *  - Every test case is executed remotely via Judge0 (works uniformly for
 *    Python, JavaScript, C++, Java, and C — no client-side Pyodide
 *    dependency for official grading).
 *  - The response contains ONLY pass/fail + timing per test case. Expected
 *    output, actual stdout, and stderr are never included in the response,
 *    for visible or hidden test cases alike — so there's nothing to read
 *    out of devtools/network tab after a submission.
 *
 * Deploy:
 *   cd functions
 *   npm install
 *   firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// Judge0 CE public instances — same hosts the client already uses for
// non-Python languages, now used here for every language.
const JUDGE0_HOSTS = [
  'https://ce.judge0.com',
  'https://extra-ce.judge0.com',
];

const JUDGE0_LANG_IDS = {
  python:     71, // Python 3.8.1
  javascript: 63, // Node.js 12.14.0
  cpp:        54, // C++ (GCC 9.2.0)
  java:       62, // Java (OpenJDK 13.0.1)
  c:          50, // C (GCC 9.2.0)
};

const MAX_CODE_LENGTH   = 20000;
const MAX_TESTCASES     = 50;
const POLL_INTERVAL_MS  = 500;
const POLL_MAX_ATTEMPTS = 20; // ~10s worst case per test case

// Same normalization the client used to use — trims each line, unifies
// line endings, drops leading/trailing blank lines. Kept identical so
// grading behavior doesn't silently change for students.
function normalize(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').map(l => l.replace(/[ \t]+$/, ''))
    .join('\n').trim();
}

function b64(str) { return Buffer.from(String(str || ''), 'utf8').toString('base64'); }
function unb64(str) { return str ? Buffer.from(str, 'base64').toString('utf8') : ''; }

async function judge0Run(code, language, stdin) {
  const langId = JUDGE0_LANG_IDS[language];
  if (!langId) throw new Error(`Unsupported language: ${language}`);

  let lastErr;
  for (const host of JUDGE0_HOSTS) {
    try {
      const submitRes = await fetch(`${host}/submissions?base64_encoded=true&wait=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_code: b64(code),
          language_id: langId,
          stdin: b64(stdin),
        }),
      });
      if (!submitRes.ok) throw new Error(`Judge0 submit failed (${submitRes.status})`);
      const { token } = await submitRes.json();
      if (!token) throw new Error('Judge0 did not return a submission token');

      let result = null;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        const pollRes = await fetch(`${host}/submissions/${token}?base64_encoded=true`);
        if (!pollRes.ok) continue;
        result = await pollRes.json();
        // status.id: 1=In Queue, 2=Processing, 3=Accepted, >3 = various errors
        if (result.status && result.status.id > 2) break;
      }
      if (!result) throw new Error('Judge0 polling timed out');

      return {
        stdout:     unb64(result.stdout),
        stderr:     unb64(result.stderr) + unb64(result.compile_output),
        exitCode:   result.status && result.status.id === 3 ? 0 : 1,
        statusName: result.status ? result.status.description : 'Unknown',
        timeMs:     result.time ? Math.round(parseFloat(result.time) * 1000) : null,
      };
    } catch (e) {
      lastErr = e; // try the next Judge0 host
    }
  }
  throw lastErr || new Error('All Judge0 hosts failed');
}

exports.gradeSubmission = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .https.onCall(async (data, context) => {
    // ── Auth guard — no anonymous grading ────────────────────────────
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'You must be signed in to submit code.');
    }

    const { questionId, code, language } = data || {};
    if (!questionId || typeof questionId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'questionId is required.');
    }
    if (typeof code !== 'string' || !code.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'code is required.');
    }
    if (code.length > MAX_CODE_LENGTH) {
      throw new functions.https.HttpsError('invalid-argument', 'Submitted code is too large.');
    }
    if (!JUDGE0_LANG_IDS[language]) {
      throw new functions.https.HttpsError('invalid-argument', `Unsupported language: ${language}`);
    }

    // ── Load the authoritative test cases ────────────────────────────
    // This read uses the Admin SDK, which bypasses Firestore security
    // rules — that's intentional and is exactly what makes this "secure":
    // the client (student's browser) never has read access to this
    // document at all, callable or not.
    const privSnap = await db.collection('questions_private').doc(questionId).get();
    if (!privSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'No test cases found for this question.');
    }
    const privData = privSnap.data() || {};
    const testcases = (privData.testcases && privData.testcases.length
      ? privData.testcases
      : (privData.hiddenTestcases || []).map(tc => ({ input: tc.input, expected: tc.expectedOutput }))
    ).slice(0, MAX_TESTCASES);

    if (testcases.length === 0) {
      return { results: [], passed: 0, total: 0, score: 0 };
    }

    // Test cases with an index below `visibleCount` are the ones shown
    // (input-only) in the student's Test Cases panel; the rest are fully
    // hidden. This mirrors how questions are authored today — the same
    // list is written to both collections, public gets input-only.
    const pubSnap = await db.collection('questions_public').doc(questionId).get();
    const visibleCount = pubSnap.exists ? (pubSnap.data().testcases || []).length : 0;

    // ── Run every test case ───────────────────────────────────────────
    const results = [];
    let passed = 0;

    for (let i = 0; i < testcases.length; i++) {
      const tc = testcases[i];
      const hidden = i >= visibleCount;
      try {
        const run = await judge0Run(code, language, tc.input);
        const ok  = normalize(run.stdout) === normalize(tc.expected);
        if (ok) passed++;
        results.push({
          n:      i + 1,
          ok,
          hidden,
          status: run.exitCode === 0 ? 'Accepted' : (run.statusName || 'Runtime Error'),
          time:   run.timeMs != null ? String(run.timeMs) : '0',
        });
      } catch (e) {
        results.push({ n: i + 1, ok: false, hidden, status: 'Execution Error', time: '0' });
      }
    }

    const total = testcases.length;
    const score = total > 0 ? Math.round((passed / total) * 100) : 0;

    // NOTE: deliberately no `out`, `expected`, or `stderr` in the
    // response — only enough for the UI to render pass/fail + timing.
    return { results, passed, total, score };
  });
