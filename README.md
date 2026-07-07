{
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "disallowLegacyRuntimeConfig": true,
      "ignore": [
        "node_modules",
        ".git",
        "firebase-debug.log",
        "firebase-debug.*.log",
        "*.local"
      ]
    }
  ],
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**",
      "functions/**"
    ],
    "headers": [
      {
        "source": "**",
        "headers": [
          {
            "key": "Content-Security-Policy",
            "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://cdnjs.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; frame-src 'self' https://www.youtube.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebasestorage.app https://firebasestorage.googleapis.com https://*.cloudfunctions.net https://noembed.com https://openlibrary.org https://covers.openlibrary.org; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
          },
          {
            "key": "X-Frame-Options",
            "value": "SAMEORIGIN"
          },
          {
            "key": "X-Content-Type-Options",
            "value": "nosniff"
          },
          {
            "key": "Referrer-Policy",
            "value": "strict-origin-when-cross-origin"
          }
        ]
      }
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}



# ChronoCode → integrated into CodingHub

`CodingHub.html` is your original file with ChronoCode added natively — same
single-file pattern, same Firebase project, same Monaco/Piston stack, same
visual language (CSS variables, `.btn`, `.sbar-item`, `.prof-panel` etc).
Nothing in your existing exam/course/violation code was modified — every
addition is new functions, new IDs, new Firestore collections.

## What was added

**Professor side** (Professor Portal → sidebar → new **⏱️ ChronoCode** item, under "Exam Management"):
- **Challenges** — list of all ChronoCode timelines created
- **Builder** — define a title, language, and timeline stages (each with a time offset in seconds + requirement text)
- **Sessions & Replay** — table of every candidate session, click "View Replay" to scrub through every recorded code snapshot in a read-only Monaco editor, see the event log, and view the AI adaptability score once evaluated

**Student side** (Course Catalog / My Learning → new tab **⏱️ ChronoCode**):
- Browse available ChronoCode challenges → **Start**
- Enter name → **Begin Session** → timer starts, Monaco editor opens, requirement panel updates automatically as stages unlock
- **▶ Run** executes via your existing `pistonExecute()` (Pyodide for Python, Judge0 for everything else — no new execution path)
- **Submit & End Session** records the final snapshot and fires the AI evaluation request

## New Firestore collections

- `chrono_challenges` — `{ title, language, description, stages[], createdBy, createdAt }`
- `chrono_sessions` — `{ challengeId, challengeTitle, candidateName, candidateUid, status, currentStageIndex, events[], finalCode, aiEvaluation, startedAt, endedAt }`
- `chrono_sessions/{id}/snapshots` — `{ code, elapsedSeconds, stageIndex, trigger, ts }`

Your existing Firestore security rules need a rule for these — add to whatever rules file you deploy:

```
match /chrono_challenges/{id} {
  allow read: if true;
  allow write: if request.auth != null; // tighten to admin/prof claim if you have one
}
match /chrono_sessions/{id} {
  allow read, create, update: if request.auth != null;
  match /snapshots/{sid} {
    allow read, create: if request.auth != null;
  }
}
```

## AI evaluation — Cloud Function required

Same reasoning as your SmartHR Anthropic/Twilio key handling: the API key can't
live in `CodingHub.html`. The function in `functions/index.js` here is
identical to the standalone ChronoCode one — deploy it the same way:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase deploy --only functions
```

Then in `CodingHub.html`, find this constant (placed right after your existing `FB_CONFIG` block) and paste the deployed URL:

```js
const CHRONO_AI_ENDPOINT = "https://REGION-YOUR_PROJECT_ID.cloudfunctions.net/evaluateAdaptation";
```

Until that's deployed, sessions submit fine and replay works fully — the AI score panel just shows "pending" instead of a score.

## Works without Firebase too

Because `fsReady()` already exists in your app to detect demo mode, all the
new `chrono*` data functions fall back to an in-memory store automatically —
so you can demo the entire ChronoCode flow (builder → take session → replay)
even before deploying anything.

## Things worth doing next (not included)

- Tying a ChronoCode challenge to anti-cheat (your DOM guard / tab-switch detection currently only runs in the exam editor flow, not the ChronoCode editor) — straightforward to wire in if you want session integrity here too.
- Per-stage test cases / auto-grading (currently Run is manual/interactive, like your `w3RunCode` learn-page sandbox, not auto-graded against expected output).
- Restricting the "+ New Challenge" / Builder views to `prof` role only at the Firestore rules layer (right now any authenticated user could technically write to `chrono_challenges` if they called the function directly — fine for your current single-admin setup, but worth tightening before wider use).
