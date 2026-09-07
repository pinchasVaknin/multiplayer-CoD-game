# OPERATOR — Playtest round 5: the report, and the sessions that answer it

הדוח מסבב ה-playtest החמישי, מפורק ל-14 סשנים + כללי עבודה משותפים. הפירוק **לפי סיבת שורש
ולא לפי סדר הדוח**: דיווחים שנראים שונים ומגיעים מאותו מנגנון יושבים באותו סשן.

הסבב הזה נאסף אחרת מסבבים 1-4, ובצורה שמשנה את כלל האימות — ראה **"How this round was
gathered"** מיד אחרי מפת הסשנים, וקרא אותו לפני P0.

---

## איך מריצים

סשן טרייה בתיקיית הפרויקט, ושורה אחת:

    Execute P1 from docs/PLAYTEST-ROUND-5.md

אין מה להעתיק. הקובץ נקרא מהדיסק — אז הוא צריך להיות שם, וכדאי לעשות לו commit אם אתה
עובד בענף אחר.

---

## How a session here is run

You have been asked to execute one of the sessions below — P1 through P14. Only that one.

Everything you need is in this file: the report as it was written, in "The report, verbatim";
how it was gathered and what that costs you, in "How this round was gathered"; the rules that
bind every session, in "P0 — Ground rules"; and your own brief.

**Read "How this round was gathered" and "P0 — Ground rules" in full before you touch code, and
treat every rule in P0 as binding.** It is not preamble: it says what counts as a fix here, what
is banned, what the gate is, what you may claim to have verified, and what you must produce
before the session ends.

One session per fresh session. The only handover between them is `PLAN.md` and this file.

**Ids in this file are round 5's own.** Where a round-4 item is meant, it is written `R4-F9`.

---

## מפת הסשנים

| # | נושא | פריטי הדוח | תלוי ב־ |
|---|---|---|---|
| P0 | Ground rules — חלות על כל סשן | — | — |
| P1 | The screen layer, and content taller than it | B1, B2, B3 | — |
| P2 | Dealing the roster: one cursor, two teams | B4 | — |
| P3 | A shot is not a damage event | B5 | — |
| P4 | A match that pays nothing | B6 | P3 |
| P5 | The score the client does not have | B7 | — |
| P6 | Capabilities the game assumes and never checks | B8, F1 | — |
| P7 | The URL is a contract | B9 | — |
| P8 | The sky, and what is past the walls | F2 | — |
| P9 | Reading a hit | F3, F5 | — |
| P10 | Bodies | F4 | — |
| P11 | The first thirty seconds | F6, F7, F13 | — |
| P12 | What the HUD knows and does not say | F8, F9 | — |
| P13 | Level 1 | F10 | — |
| P14 | Planning brief: deployment and the hidden tab (no game code) | F11, F12 | — |

סדר: P1 → P2 → P5 → P3 → P4 → P7 → P6 → P9 → P12 → P11 → P13 → P8 → P10 → P14.

הרציונל לסדר: קודם שני החוסמים (P1, P2), אחר כך הבאג היחיד שהמשחק עצמו מדווח עליו בקונסולה
(P5), אחר כך תיקוני נכונות זולים, ורק אז העבודה הוויזואלית הגדולה (P8, P10), שהיא הכי יקרה
והכי פחות דחופה. P14 הוא תכנון בלבד.

---

## How this round was gathered

Rounds 1-4 were a human playing and reporting feel. This round was not, and you must know
exactly what that changes.

The session ran the deployed build at `https://multiplayer-cod-game.onrender.com/` in an
embedded browser pane. **That browser refused pointer lock** (`WrongDocumentError` — that
refusal is itself B8), so the "player" could not aim with a mouse. Input was driven through
`window.__operator` and through a hook that pointed the camera at the nearest living enemy
each tick, and the keyboard was driven with synthetic `KeyboardEvent`s.

What that means for you, concretely:

- **The scorelines in this report are not evidence about balance.** The player was bad on
  purpose and stood still for long stretches. Where a scoreline is cited, it is cited for the
  *roster* behind it, never for the outcome.
- **Everything about feel is missing.** Recoil, time-to-kill, movement, audio, weapon handling:
  nobody assessed them this round. An absence here is not a pass.
- **The frame numbers are real.** `__operator.frameReport()` returned 600 consecutive samples
  with p50 16.7ms. That cannot happen under a throttled `requestAnimationFrame`, so the pane
  was live and visible when it was taken.
- **The clock numbers are not.** Late in the session the pane went hidden
  (`document.visibilityState === "hidden"`), and that is where the `ticks behind` warnings in
  F12 come from. Treat them as an observation to reproduce, not as a measurement.

One reported item was **withdrawn after being tested properly**, and it is recorded here
because it is the shape of mistake this method makes: the report initially said there was no
automatic reload on an empty magazine. A controlled probe — hold fire, sample `mag`, `reserve`,
`reloading` and `dryFiredThisTick` every 250ms — showed the opposite, and showed it working
exactly as `WeaponBase.stepTrigger` reads: the magazine empties at `t=2.25s`, the dry fire and
the reload begin on the same tick, and the weapon is firing again at `t=5.25s` with `reserve`
down by 30. It is not in the list. **If an item below smells like this one, kill it the same
way before you fix it.**

---

## The report, verbatim

Hebrew as reported, with an English gloss. The prompts refer to these ids.

### Bugs

- **B1** — התפריט הראשי נחתך למעלה ולמטה ואי אפשר לגלול אליו. ב-viewport של 1366×626 (מסך
  1366×768 עם כרום רגיל) גובה התוכן הוא 744px: הכותרת `OPERATOR` יושבת ב-`y = −118`, מחוץ
  למסך למעלה, ו-`RESET PROGRESS` ב-`y = 700`, מתחת לקצה. הגלגלת לא עושה כלום.
  *The main menu is clipped at both ends and cannot be scrolled to. At 1366×626 the content is
  744px tall: the title sits at y = −118 and RESET PROGRESS at y = 700.*
- **B2** — מתחת ל-840px רוחב, מסך בחירת המשחק מגיע ל-833px גובה ו-`START MATCH` יורד מתחת
  לקצה. בחלון צר, בטאבלט או בטלפון אי אפשר בכלל להתחיל משחק סולו.
  *Below 840px wide, the setup screen is 833px tall and START MATCH goes off the bottom. In a
  narrow window a solo match cannot be started at all.*
- **B3** — לוח הסיום נחתך לרוחב: עמודות ה-AXIS יוצאות מהמסך ומופיע scrollbar אופקי.
  *The post-match board overflows horizontally; the AXIS columns are cut off.*
- **B4** — ה-VETERAN היחיד ב-mix תמיד נופל לקבוצה היריבה. בשני משחקים ה-roster היה זהה:
  קבוצה A (הצד של השחקן) `REGULAR · HARDENED · RECRUIT · REGULAR`, קבוצה B
  `VETERAN · HARDENED · REGULAR · RECRUIT · REGULAR`. ה-VETERAN סיים 36 הריגות מול 5 מיתות.
  *The only VETERAN always lands on the opposing team. Identical roster in both matches; that
  bot finished 36/5.*
- **B5** — אחוז הפגיעה יכול לעבור 100%. לוח הסיום הציג `CINDER · ACC 267%` מתוך
  `25 shots / 62 hits`. אותו מספר מופיע גם בלוח שנפתח עם Tab.
  *Accuracy can exceed 100%; 267% was shown on the summary board.*
- **B6** — משחק שלם יכול לשלם 0 XP. מאצ' עם 0 הריגות, 6 מיתות והפסד נתן `+0 XP`, פאנל הפירוט
  מתחת לבר נשאר קופסה ריקה, והתפריט אחריו חזר להגיד "500 XP TO NEXT" עם הבר על אפס.
  *A whole match can pay zero XP, and the breakdown panel under the bar stays an empty box.*
- **B7** — המשחק מדווח בעצמו על divergence בתוצאה. בקונסולה, ברמת `error`, עשרות פעמים:
  `DIVERGENCE on tick 67010: scoreA — client says 0, server says 69. Confirmed across 4
  consecutive snapshots` (ובמקביל `scoreB — client says 0, server says 75`).
  *The game's own divergence detector fires on the score: client 0, server 69/75, confirmed
  across four consecutive snapshots, logged dozens of times at error level.*
- **B8** — כשהדפדפן מסרב ל-pointer lock, השחקן לא מקבל שום הודעה. המשחק כותב
  `[Input] pointer lock error` לקונסולה וממשיך — מאצ' חי, HUD מלא, טיימר רץ, ואי אפשר לכוון.
  *When the browser refuses pointer lock the player is told nothing; the match runs on, unaimable.*
- **B9** — `?name=` ו-`?server=1` מתועדים ב-README ולא נתפסים. שני קליינטים התחברו כ-
  `OPERATOR-013` למרות `?name=BRAVO`, ו-`?server=1` השאיר את המשחק ב-MENU עד לחיצה ידנית על
  `PLAY MULTIPLAYER`.
  *The documented URL flags are ignored.*

### Additions, changes, upgrades

- **F1** — מכשירי מגע: אין קלט מגע בכלל (אין `touchstart`/`pointerdown`/`maxTouchPoints`
  ב-`src/client/`), אבל התפריט נטען רגיל, מציג WASD ו-F11, ונחתך (844px בתוך 812px).
  *Touch devices: no touch input exists, yet the menu loads and invites you to play.*
- **F2** — שמיים ואופק. `scene.background` הוא צבע הערפל וזהו: אין גרדיאנט, אין שמש, אין
  עננים, ומעבר לקירות הגבול אין שום דבר.
  *A real sky and a horizon. Today the sky is one flat colour and there is nothing past the walls.*
- **F3** — חורי הכדורים גדולים מדי: כתמים שחורים רכים ברוחב 30-40 ס"מ בעולם.
  *Bullet decals are far too large.*
- **F4** — גופים: ידיים, רגליים, מחזור הליכה ו-prop של הנשק ביד. (המשך ל-R4-F4, שדיבר על סקינים
  ומודלים — זו המדרגה הזולה שלפניו.)
  *Bodies: arms, legs, a walk cycle, the weapon in hand — the cheap step before R4-F4's skins.*
- **F5** — ניגודיות הכוונת: `.hud-cross__line` הוא 2×7px לבן עם `box-shadow: 0 0 2px`. ב-Dunes
  באור מלא הכוונת כמעט בלתי נראית.
  *Crosshair contrast: the soft 2px shadow is not enough on bright sand.*
- **F6** — תאורה בחדר ההמתנה. R4-F9 דיבר על "המגרש השלישי"; בפועל ה-testbed שאליו נוחתים מיד
  אחרי `PLAY MULTIPLAYER` הוא כמעט שחור, וזה הרושם הראשון של כל מי שנכנס דרך הלינק.
  *Warmup-room lighting. Wider than R4-F9: the room every player lands in is nearly black.*
- **F7** — מעגל הכיבוש ב-Domination הוא דיסקה ירוקה רוויה ואטומה. הטבעת של הצד השני דווקא
  נראית טוב.
  *The Domination capture fill is a flat opaque disc.*
- **F8** — חיווי A/B/C בסרגל העליון. הסרגל מציג שתי תוצאות וטיימר; מי מחזיק איזה דגל קריא רק
  מהמיני-מפה.
  *An A/B/C ownership strip in the top bar.*
- **F9** — מסך המוות לא אומר מי הרג אותך, עם מה, וכמה חיים נשארו לו.
  *The death screen names nobody.*
- **F10** — לפתוח 2-3 נשקים ראשיים ברמה 1. היום יש אחד (M4), כל השאר נעולים מרמה 4 ומעלה, וכל
  חמש ה-classes מציגות אותו נשק.
  *Unlock two or three primaries at level 1.*
- **F11** — Render: `plan: free`, אז השירות נרדם. חזרה לכתובת אחרי הפסקה נתנה cold start של
  כ-20 שניות על דף הטעינה הממותג של Render, עם 503 באמצע — ולא על מסך של המשחק. וגם: זירת
  ההמתנה ה"קבועה" וכל מאצ' חי נהרסים בכל שינה.
  *Render's free plan: the service sleeps, and the permanent arena dies with it.*
- **F12** — למדוד את פיגור השעון ואת הניתוק. בטאב מוסתר הקונסולה הראתה
  `[netclient] 62 ticks behind the server clock; resynchronising` ברצף של עשרות שורות סביב
  55-63 טיקים, ובסוף `[netclient] server closed the connection: timeout`. הטאב היה מוסתר —
  ולכן זו תצפית לשחזור, לא מדידה.
  *Measure the clock lag and the timeout. Observed in a hidden tab, so it needs reproducing.*
- **F13** — `[join] no background build ready for mp_testbed; building it now (expect a hitch)`.
  ההבטחה של M11 היא מעבר בלי מסך טעינה; בסיבוב הזה הבנייה המקדימה לא הייתה מוכנה.
  *The background build was not ready, and the code says so.*

### מה שנבדק ונמצא עובד — אין מה לגעת

- `R4-F2` — חץ הכיוון לפצצה קיים ועובד.
- `R4-F10` — הסבר קצר לכל מוד מופיע: `CAPTURE AND HOLD · A, B, C · 200 POINTS`,
  `ONE LIFE · ATTACKERS PLANT THE BOMB AT A OR B`.
- `R4-F12` — "WAITING" מופיע במרכז למעלה בזירה.
- `R4-F14` — תג `CHEATS · GOD · UNSEEN` מוצג על המסך כשצ'יט פעיל.
- `R4-F15` — בורר הנשקים מציג מודל תלת-ממדי וטבלת סטטים מלאה, כולל שינויי perk בכתום.
- `R4-F8` — reconnect עובד: `[netclient] rejoined as entity 5 on team A`.
- `R4-B9` — מחיר ההריגות מוצג על סרגל הסטריקים.
- טעינה אוטומטית של מחסנית — ראה "How this round was gathered".

### The good news, measured

זה לא חלק מהעבודה, אבל זה ההקשר שבו כל השאר נקרא. כל מספר כאן יצא מהרצה בסשן הזה:

| מה | מדידה | מאיפה |
|---|---|---|
| פריימים | p50 16.7ms · p95 16.8 · p99 17.0 · הגרוע 17.5, על 600 דגימות | `__operator.frameReport()` |
| Bundle | 397KB gzip · 1.37MB גולמי · **3 בקשות רשת סה"כ** | Resource Timing |
| טעינה | 468ms load · 104ms TTFB (שרת ער) | Navigation Timing |
| רשת | RTT 99.8ms · jitter 0.29ms · loss 0% · `snapshotsLost 0` | `netclient.stats` |
| סנאפשוטים | 19.99/s · 158.6B בממוצע · 4.1KB/s נכנס · 4.5KB/s יוצא | `netclient.stats` |
| מולטיפלייר | שני קליינטים, כל אחד ראה את השני כ-actor מרוחק, `interpolationDelayMs 100` | `world.net.actors` |

---

# P0 — Ground rules

Binding on every session below. Round 4's P0 still applies; this is that document with the
changes this round forces. Where they differ, this one wins.

## Read before you touch code

1. `PLAN.md`, from `# M11 Gate B — in progress` to the end. That is playtest rounds 1-4: what
   was reported, what it turned out to be, and what was measured.
2. `docs/PLAYTEST-ROUND-4.md` — the previous round in full, including its P0. Several items
   here extend items there.
3. `docs/PLAYTEST-ROUND-5.md` — this report in full. Your session is one part of it.
4. `package.json` — the scripts are both the gate and the instruments. Read the `//` notes.

## The rules

**1. Root cause, not a plaster.**
Before you write a line, put the mechanism in one sentence: *"the symptom exists because X."*
If you cannot write that sentence you do not yet understand the bug — keep reading. A fix that
removes the symptom without naming the mechanism is rejected.

Explicitly banned, even when they work:

- a timer or delay to let state "settle";
- a new boolean beside existing state instead of deriving from the state already there;
- a second writer that undoes the first;
- an `if (networked)` branch duplicating a rule that already exists elsewhere;
- a `try/catch` that swallows;
- a magic number tuned until the observation stopped.

The shape that is allowed is the opposite: **one writer, and a value derived from state that
outlives the surface displaying it.**

**2. Look for the shared cause.**
If your session carries several reports, ask whether they are one mechanism before fixing each
separately. P1 this round is three symptoms of one missing CSS property; do not fix it three
times.

**3. This round's reporter was not a human playing.**
Read "How this round was gathered" before you believe any line in the report. An item that
rests on a scoreline rests on a bad player. An item that rests on a `console` line, a
`getBoundingClientRect`, or a field read out of `__operator` rests on a measurement, and those
are the ones to trust. **Two items are explicitly marked as needing reproduction before they
are fixed — F12 and, in part, B7.** Reproducing them is the work; a fix without the
reproduction is rejected.

**4. Authority: a fact that moved to the server breaks every reader of the local copy, silently.**
That is this milestone's recurring failure, and B7 is it again, out loud, in the game's own
divergence log. When you touch a fact the server owns, walk every reader of it, not only the
one that was reported.

**5. Boundaries.**
`shared/` compiles without the DOM lib. The client/server/shared partition is enforced by
`scripts/check-boundaries.mjs`, which runs first for a reason. Cosmetics do not touch
simulation; `scripts/check-cosmetics.mjs` fails if they do — **P8, P9, P10 and P11 are entirely
inside that boundary and none of them may change a simulated value.**

**6. The gate.**
`npm run check` must pass before you commit. Anything touching simulation or the wire also runs
the relevant harness:

- `npm run harness` — local simulation, N matches
- `npm run netharness` — headless clients against a real server
- `npm run skirmish` — connect, warmup, vote, migrate, match, return
- `npm run leak` — 100 allocate/destroy cycles; heap and live EventBus subscriptions flat

If you changed the wire format, bump the protocol version and say so.

**7. The verification split, and this round it is harder.**
**Never invent a number.** Every number in your summary must come out of a run you did in this
session, named with the probe that produced it.

`HeadlessClient` drives `NetClient` and `Prediction` directly and builds no `ClientMatch`, so
any claim about the HUD, about input, or about what appears on screen is untested even when the
harness is green. The preview pane never fires `requestAnimationFrame`, so do not claim visual
verification through it.

New this round, and it applies to most of the sessions: **a layout bug is measurable without a
human.** `getBoundingClientRect()` against a set viewport is a number, and P1's items were all
found that way. Where a session can turn "it looks wrong" into a rect, a computed style or a
console line, that is not "needs a browser" — that is a probe you owe.

End every session with an explicit **"needs a browser"** list with exact reproduction steps, for
what genuinely remains.

**8. Scope.**
Fix only the items in your session. If you meet an adjacent defect: if it is the same cause, fix
it and say so; if it is not, record it in `PLAN.md` under "Found while here" and leave it.

**9. What you produce.**

- A section in `PLAN.md` in that file's voice — prose, not ticket bullets: what was reported,
  what the mechanism was, what changed, what was measured and by how much, and what still needs
  a browser. If you reversed an earlier decision, **rewrite the old section**.
- One commit, in the style already there — a sentence describing what was found, not `fix: ...`.
  Run `git log --oneline -10` and match it.

**10. Language.**
Code, comments, `PLAN.md` and the commit message: English, in the existing voice. The closing
summary to the user: Hebrew.

## How to start

Plan first. For each item in your session write the hypothesis sentence — *"the symptom exists
because X"* — and the call sites you will read to confirm or kill it. Show that list before you
write code.

---

# P1 — The screen layer, and content taller than it

Covers **B1, B2, B3**.

## Three reports, one missing property

1. B1 — the main menu is cut off at the top and the bottom, and the wheel does nothing.
2. B2 — in a narrow window `START MATCH` is below the fold, so no solo match can be started.
3. B3 — the post-match board runs off the side.

The mechanism is already established, so this session is not a hunt — it is a decision about
where the fix belongs. `.op-screen` in `src/client/ui/styles/app.css` (around line 55) is:

    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;

There is no `overflow-y`. When the content is taller than the box, `justify-content: center`
distributes the overflow to **both** ends, and the half that goes off the top of a scroll
container is unreachable even when scrolling is enabled — that is the classic failure of
centring plus overflow, and it is why B1 reads as "the wheel does nothing" rather than
"the page is long".

The measurements, so you can reproduce before and after:

| screen | viewport | content height | what is off-screen |
|---|---|---|---|
| main menu | 1366×626 | 744px | title at `y = −118`; `RESET PROGRESS` at `y = 700` |
| solo setup | 596×696 | 833px | `START MATCH` at `y = 785` |
| solo setup | 1366×626 | 626px | nothing — it fits |

That third row is the interesting one. `.op-pickers` is
`grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))` inside `width: min(840px, 92vw)`,
so at 840px and up it is three columns and short, and below it folds to one column and grows
past the viewport. B2 is therefore **a width bug that presents as a height bug**, and any fix
that only special-cases the setup screen has missed it.

## Starting points

The precedent for the correct shape is already in the same file: `.op-settings` (around line
558) is `max-height: 56vh; overflow-y: auto; overscroll-behavior: contain`, with a comment
saying "tall enough for the binding list, short enough that Back stays on screen". That comment
is the invariant, written once and never generalised. The Settings screen is the only one that
does not have this bug, and that is not a coincidence.

For B3, `Scoreboard.ts` and its CSS: the same story on the other axis. Round 4's F11 already
established the convention this file follows — "the **content** carries the cap while the layer
stays full-bleed and centres it" — and the post-match board is where that convention was not
applied.

## What I want out of this beyond three fixes

**One rule at the layer, not three at the leaves.** `.op-screen` should be able to hold content
taller and wider than itself without any individual screen knowing about it: scrollable, with
centring that degrades to start-alignment instead of clipping (`justify-content: safe center`,
or `margin-block: auto` on the child, whichever survives your check of the other screens), and
vertical padding so nothing sits flush against an edge.

**And a probe, because P0 rule 7 says a layout bug is a number here.** A small harness that
mounts each full-screen surface at a list of viewports — at minimum 1366×626, 1280×600,
1024×640, 800×600, 596×696, 375×812 — and asserts that every focusable element's rect is inside
the viewport, or reachable by scrolling. That turns "the menu is cut off" from something someone
notices into something the gate catches. The viewport list belongs in the repo, not in this
file.

## Verification

- The probe above, green at every listed viewport, for: menu, solo setup, settings, pause,
  summary, create-a-class.
- `npm run check` green. Nothing outside `client/ui/` should need to change; if it does, say why.
- Needs a browser — one pass at 1366×768 with the window maximised and then at half width,
  confirming that `RESET PROGRESS` is reachable and that a solo match can be started in both.

---

# P2 — Dealing the roster: one cursor, two teams

Covers **B4**.

## This is not balance tuning. It is an off-by-a-team.

`BotDirector.populate` (`src/shared/ai/BotDirector.ts:385`):

    const add = (team, count) => {
      for (let i = 0; i < count; i++) {
        const tier = tierMix[this.nextIndex % Math.max(tierMix.length, 1)] ?? 'REGULAR';
        this.createBot(team, tier);
      }
    };
    add('A', teamA);
    add('B', teamB);

One cursor, and team A is filled to completion before team B starts. The mix
(`src/shared/modes/ModeRegistry.ts:190`) is:

    ['REGULAR', 'HARDENED', 'RECRUIT', 'REGULAR', 'VETERAN', 'HARDENED', 'REGULAR', 'RECRUIT']

`VETERAN` is at index 4. In a 5v5 with a human, team A takes four bots — indices 0-3 — so index
4 is always the first bot dealt to team B. **Every match. Not a seed, not variance.** The
observed roster matches the arithmetic exactly:

| team | tiers dealt | indices |
|---|---|---|
| A (player's side) | REGULAR · HARDENED · RECRUIT · REGULAR | 0, 1, 2, 3 |
| B | VETERAN · HARDENED · REGULAR · RECRUIT · REGULAR | 4, 5, 6, 7, 8→0 |

The comment above `populate` says the round-robin exists "so a default match is a spread rather
than ten identical opponents". It delivers that per match and not per team, which is the bug:
the spread is real and it is all on one side.

`server/Match.ts:1485` calls the same function with the same mix, so this is not a solo-only
path — it is the shipped multiplayer roster too.

## The decision I want made explicitly, not silently

Interleaving the deal fixes the asymmetry, but there is a second question underneath it and I
want it answered in `PLAN.md` rather than assumed: **the human seat is not a bot seat.** Team A
carries a player who is, on average, worse than a REGULAR bot and much worse than a VETERAN.
Mirroring the tiers exactly still hands team B a real edge, because team B's fifth body is a bot
and team A's is a person.

Two defensible answers — pick one, write down why:

1. Mirror the spread and accept that the human seat is the handicap.
2. Deal the stronger half to the player's side, so the human seat is compensated rather than
   compounded.

Whichever you choose, `replacePlayerWithBot` has to agree with it: round 4 already found that
call site disagreeing with `populate`, and this is the same seam.

## What I want out of this beyond one fix

**A headless assertion, wired into `npm run harness`:** over N seeds and every mode, the
multiset of tiers on team A and on team B differ by at most one entry, and no tier appears on
one side only. That is the artefact that stops this coming back the next time the mix is
edited — and the mix *will* be edited, because it is a literal in a registry.

## Verification

- The assertion above, green over at least 100 seeds.
- `npm run harness` — report per-tier kill rate per team before and after. The point is not that
  the numbers are equal; it is that they are no longer separated by which side the VETERAN
  landed on.
- `npm run check` green.
- Needs a browser — nothing. This one measures cleanly.

---

# P3 — A shot is not a damage event

Covers **B5**.

## The mechanism, and it is already solved twelve lines away

`src/shared/combat/ScoreSystem.ts`:

- line 177 — `EV.WeaponFired` → `row.shotsFired++`. One trigger pull, one increment. Correct.
- line 184 — `EV.DamageDealt` → `row.shotsHit++`. One *damage event*, one increment.

A damage event is not a shot. A shotgun trigger pull produces up to eight of them; a penetrating
round produces one per victim; an explosive produces one per body in radius. So `accuracy()`
(line 388) divides events by pulls and returns 267%.

`EV.WeaponFired` already carries what is needed. From `shared/core/Events.ts:202`, with the
comment that explains why:

    /**
     * M5. One trigger pull is one event even for a shotgun, so the pellet count and how
     * many of them connected ride along — a second event per pellet would fire eight muzzle
     * flashes and eight gunshots for one bang.
     */
    pellets: number;
    pelletsHit: number;

And `shared/meta/MatchProgression.ts:137` already consumes it correctly: `tally.shotsFired += p.pellets`.

So two subsystems compute the same statistic from two different definitions, and one of them is
right. This session's job is to leave exactly one definition behind.

## The question that has to be answered before the edit

**Should explosive and equipment damage count as a "hit" at all?** Today it does, silently, and
that is a second way the number is wrong that nobody reported because it is smaller. A frag that
catches three people adds three hits and no shots. Decide, write it down, and make the decision
visible at the call site rather than implied by which event you happened to subscribe to.

The same question applies to `SentryGun` and `ChopperGunner`, which keep their own
`shotsFired`/`shotsHit` (`shared/streaks/`) — are a sentry's rounds the player's accuracy? The
debug panels already display these as percentages (`client/debug/StreakPanel.ts:142`), so
whatever you decide, those read-outs must agree.

## What I want out of this beyond one fix

One exported pair of functions — "what counts as a shot", "what counts as a hit" — used by
`ScoreSystem`, `MatchProgression`, `BotDirector` (`shotsHit++` at line 648, `shotsFired++` at
line 605) and `server/Match.ts:598,612`. Five call sites currently agree by luck. And a note in
`PLAN.md` with the accuracy of a shotgun bot before and after, because that is the number that
proves it.

## Verification

- `npm run harness` with a roster forced to shotguns: no row's accuracy exceeds 100%, and the
  headline hit-rate per tier moves in the direction you predicted before you ran it.
- A headless case for the three shapes that used to inflate: multi-pellet, penetration, explosive.
- `npm run check` green.
- Needs a browser — one look at the post-match board with a shotgun class, confirming the ACC
  column reads something under 100.

---

# P4 — A match that pays nothing

Covers **B6**. Do this after P3 — the same summary screen, and P3 may move numbers it displays.

## Two defects wearing one coat

`shared/meta/XpRules.ts:63` — the whole award table:

    kill 100 · headshot 25 · assist 50 · objective 200 · longshot 30
    challenge · weaponLevel 250 · win 500 · mvp 300 · streak 25

Every row is contingent on succeeding. There is no row for showing up. A player who goes 0-6 and
loses earns nothing, and the menu behind the summary then says "500 XP TO NEXT" with the bar
still on zero — the game's answer to a full match is that it did not happen.

The second defect is next to it and is arguably worse: **the breakdown panel under the bar
renders as an empty box** rather than as "no XP earned" or as rows with zeros. An empty panel
reads as broken, not as harsh.

Note the interaction with P2, and it is not incidental: B4 means the player's side is
systematically the losing side, so B6 fires far more often than the design intends. Fixing P2
reduces how often anyone sees this. It does not fix it.

## The rule I want built, not a tenth row bolted on

A match that was played pays something. State it as a rule with a number attached, in the same
table, so it participates in the same summing and the same animation as everything else — a flat
award for reaching the end of a match, and a per-minute term so that a long match pays more than
a short one. Both belong in `XP_SOURCES`, not in a special case at the summing site.

Two edges to decide explicitly:

- **Leaving early.** Does a player who quits at 30 seconds get the flat award? If the answer is
  no, the rule needs a completion condition, and that condition needs to survive a reconnect
  (`R4-F8` is implemented — `rejoined as entity 5` was observed — so a reconnected player must
  not lose credit for the minutes before the drop).
- **The warmup arena.** Round 4's F7 asked for no scoring in the waiting room. Time there must
  not pay.

## What I want out of this beyond one fix

The summary panel should be unable to render empty. Whatever the tally, it shows rows — and
`XpSummary.ts` should take a tally that is always non-empty rather than defending against one
that is. Make that a property of the type, not of the renderer.

## Verification

- Headless: a tally from a 0-kill losing match is non-zero, and the rows it produces are
  non-empty. A tally from 30 seconds of warmup is zero.
- `npm run skirmish` — a full flow, and the XP awarded at the end recorded in `PLAN.md`.
- `npm run check` green.
- Needs a browser — the summary screen after a deliberately bad match: the number is not zero
  and the panel has rows in it.

---

# P5 — The score the client does not have

Covers **B7**. This is the only item this round that the game reported about itself.

## What was seen

At `error` level, dozens of times, from the deployed build:

    [divergence] DIVERGENCE on tick 67010: scoreA — client says 0, server says 69.
                 Confirmed across 4 consecutive snapshots.
    [divergence] DIVERGENCE on tick 67010: scoreB — client says 0, server says 75.
                 Confirmed across 4 consecutive snapshots.

Both scores, same tick, and the detector's own confirmation window satisfied — so this is not a
one-frame race that the interpolator smoothed over. The client's copy is **zero**, not stale and
not off by a few: it is the value a freshly constructed world has.

## Read this first, and treat it as a problem in itself

The surrounding console lines are the strongest clue in this report, and they are all about the
same moment:

    [netclient] rejoined as entity 5 on team A, FFA on mp_testbed.
    [join] server rotated to FFA on mp_testbed — rebuilding the world.
    [join] no background build ready for mp_testbed; building it now (expect a hitch).
    [netclient] joined as entity 5 on team A, FFA on mp_testbed.
    [world] world built for FFA on mp_testbed (server's choice).

A rotation, a rebuild, and a rejoin. The hypothesis to test — **not to adopt** — is that the
divergence is the seam between a world that was just constructed with a zeroed score and a
server that is still reporting the outgoing match's final score, and that the detector is
comparing across a boundary where the two are legitimately different things. If that is what it
is, then **the bug is the detector's, not the score's**, and the fix is that the comparison is
scoped to a match id — which is exactly the kind of answer P0 rule 4 is about: a fact the server
owns, read by something that does not know which match it belongs to.

But it may not be that. The other possibility is that the score genuinely does not replicate on
this path, and that a player who joins or rejoins mid-match sees `0 — 0` on the HUD until the
next score event moves it. **That is a real, visible, shipping bug and it would have been
invisible to every previous round**, because every previous round joined at the start.

Determine which. `world.divergence`, `net.onMatchState`, `net.scoreA`/`scoreB`, `net.lastScoreA`/
`lastScoreB`, `client.matchId` and `client.migrations` are the fields to instrument; `matchId` is
already on the `Welcome` payload, so the information needed to scope the comparison exists.

## Verification, and this one measures well

- `npm run netharness` with a client that connects **mid-match** rather than at the start, and
  asserts the first `scoreA`/`scoreB` it renders equals the server's. If that assertion fails
  before your change, you have found the real bug and P5 is a replication fix.
- `npm run skirmish` across a rotation with the divergence detector armed: zero `error` lines.
- If it turns out to be the detector, say so plainly in `PLAN.md` and fix the scope — do not
  silence the log.
- `npm run check` green.
- Needs a browser — join a running match from a second window and read the HUD score on the
  first frame.

---

# P6 — Capabilities the game assumes and never checks

Covers **B8, F1**.

## Two reports, one shape

The game needs a pointing device it can lock and a keyboard it can read. It checks for neither,
and when either is absent it says nothing:

1. B8 — pointer lock is refused, `Input` logs a warning, and the match runs on unaimable.
2. F1 — there is no touch input anywhere in `src/client/`, and yet a phone loads the menu, is
   shown a table of keyboard bindings and a note about F11, and can start a match.

Both are the same missing step: **the game never asks whether it can be played here, and never
says so when it cannot.**

## Starting points

B8: `Input` already holds the state. `lockRejectedWhileArmed` is set when the request is
refused, alongside `wantPointerLock` and `wantKeyboardLock`, and `onPointerLockError` writes the
console line. Nothing outside `Input` is told. The question is where the telling belongs — this
is a HUD surface with a single writer and a condition that outlives it, which is exactly the
invariant round 4's P1 established, so it should slot into that table rather than become a new
kind of thing.

F1: this is a gate, not a feature. `navigator.maxTouchPoints` and a coarse-pointer media query
are the test. What I want is the honest version — a screen that says the game needs a keyboard
and a mouse — and **not** a half-built touch scheme. If someone later wants to actually play on
a phone, that is its own milestone with its own budget, and it starts with movement, not with a
gate.

## The decision I want made explicitly

Is a refused pointer lock a **blocking** state or a **banner**? A banner is honest and lets a
player who can fix it (click again, press F11) do so. Blocking is honest and stops them wandering
into a match they cannot play. Round 4's F7 already made the analogous call for the waiting room
— no dying there — so there is precedent for choosing the protective answer. Pick one, write down
why, and make sure the choice survives the pause menu and a rejoin.

## Verification

- Headless: the capability predicates are pure functions of `navigator`/`document` state and are
  tested as such, without a DOM.
- `npm run check` green.
- Needs a browser — three cases, and write the steps for the human: a normal desktop run
  (nothing appears); a run inside an iframe, where pointer lock is refused, expecting the banner
  or the block; and a mobile-emulated viewport at 375×812, expecting the keyboard-and-mouse
  screen and no way to start a match.

---

# P7 — The URL is a contract

Covers **B9**.

## The report

`README.md` documents a flag table: `?server=host:port`, `?server=1`, `?name=ALICE`, `?net=…`,
`?rewinddebug=1`. Two of them do not do what it says on the deployed build:

- `?name=BRAVO` — two clients opened with different names both joined as `OPERATOR-013`. The
  profile callsign wins.
- `?server=1` — the game stayed in `MENU` until `PLAY MULTIPLAYER` was clicked by hand.

Note the second one is ambiguous and worth resolving before you touch anything: `VITE_SERVER_URL`
is baked to `"1"` at build time on Render (`render.yaml`), so on the deployed build the flag is
redundant by construction — the origin is already the server. It is possible that the documented
behaviour is "connect automatically" and it regressed, and it is equally possible that the
documented behaviour was only ever "which server", with the click always required. **Read the
code before you read the README again.**

## What I actually want here

Not "make the flags work". I want the two to stop being able to disagree.

The flag table in `README.md` is a public interface with no test. Whatever the answer turns out
to be — honour the flags, or correct the documentation — the artefact I want is a single place
where the flags are declared, that both the parser and the README's table are derived from or
checked against, so the next flag cannot be documented into existence without existing.

For `?name=` specifically, decide the precedence explicitly and record it: URL over profile, or
profile over URL? There is a real argument for the profile winning (it is the player's actual
identity, and a stray URL should not silently rename them), and if that is the answer then the
README is the thing that is wrong. The README's own use case — "open it twice, in two windows,
with different names — that is a two-player match" — is a developer workflow, and it deserves an
answer that keeps working.

## Verification

- A check that fails when the README's flag table and the parser disagree.
- `npm run netharness` — two headless clients with distinct `?name=` values appear on the
  scoreboard with distinct names, if that is the precedence you chose.
- `npm run check` green.
- Needs a browser — two windows, two names, one scoreboard.

---

# P8 — The sky, and what is past the walls

Covers **F2**. Cosmetics only: `scripts/check-cosmetics.mjs` must stay green.

## The report

`MapRender.ts:404`:

    scene.background = new THREE.Color(def.ambient.fogColor);
    scene.fog = new THREE.Fog(def.ambient.fogColor, def.ambient.fogNear, def.ambient.fogFar);

The sky is the fog colour. Looking up on Dunes gives a uniform beige rectangle. Flying above the
map gives a village floating in a void of the same beige — no horizon, no distance, nothing at
all past the boundary walls.

This is, per screenshot-for-screenshot, the cheapest large improvement available to this project,
and it is the one that costs nothing against the "zero external assets" rule.

## The shape I want, and its constraint

A gradient sky sphere, generated the way everything else here is generated: in code.

The constraint that makes it good rather than merely present: **the horizon colour must be the
map's `fogColor`.** That is what makes the seam disappear — geometry fades into fog, fog meets
the horizon, and the horizon is the same colour, so there is no line anywhere. The zenith is a
second colour, and it belongs in `def.ambient` beside `fogColor` rather than being computed with
a magic multiplier, because Foundry at night and Dunes at noon want different answers and the
map definitions are where per-map answers live.

Then two additions, in order of value:

1. **A sun disc**, positioned from the map's existing directional light rather than from a new
   number, so the light in the scene and the light in the sky cannot disagree.
2. **Distant silhouette bands** past the boundary — dunes for Dunes, a skyline for Depot,
   structures for Foundry. Flat, unlit, fogged, a few triangles. This is what makes the map stop
   feeling like a diorama.

## What I want out of this beyond one feature

Per-map values, in the map definitions, alongside the fog. If the sky ends up with a constant in
`MapRender.ts`, the sky is wrong for at least three of the four maps.

And a note in `PLAN.md` on the cost: draw calls and frame time before and after, from
`__operator.frameReport()`, on the map with the most geometry. The current p50 is 16.7ms with a
p99 of 17.0 — there is very little headroom above 60Hz to give away, and a sky sphere plus a
silhouette ring should cost approximately nothing. Prove that it does.

## Verification

- `__operator.frameReport()` before and after on Depot and Dunes, 600 samples each.
- `npm run check` green, cosmetics check green.
- Needs a browser — look up on all four maps, and fly the free cam past the boundary on each
  (`__operator.spectate.noclip(true)`), confirming the horizon reads as distance and not as a
  wall.

---

# P9 — Reading a hit

Covers **F3, F5**.

## Two reports, one job

Everything the player learns from pulling the trigger is drawn by two systems, and both are
currently hard to read:

1. F3 — the impact decals are soft black blobs 30-40cm across in world space. On a light wall
   they read as holes punched through it, not as bullet strikes.
2. F5 — the crosshair is `.hud-cross__line`, 2×7px, `rgba(232,234,238,.9)`, with
   `box-shadow: rgba(0,0,0,.9) 0 0 2px`. On Foundry, dark, it is clear. On Dunes at noon it
   nearly disappears.

The second one has a precise fix and I will name it because it is not a matter of taste: a 2px
*blurred* shadow spreads its darkness over four pixels of a two-pixel mark, so on a bright ground
there is nothing left of it. A hard ring — `0 0 0 1px rgba(0,0,0,.85)` — puts a full-strength
dark pixel against every light pixel, and holds on any background. The same applies to the
hitmarker, which has the same shadow and the same problem, and which matters more because it is
the only confirmation that a shot connected.

## For the decals, the question is what a strike looks like

Not just "smaller". A bullet hole that reads correctly is small, has a bright rim where material
was displaced, and is accompanied by a puff that dies in well under a second — the puff is what
sells it, and it is what is missing. Decide the count limit at the same time: decals accumulate,
and P0's ban on magic numbers applies to the cap as much as to anything else, so derive it or
justify it.

## Verification

- `npm run check` green, cosmetics check green.
- A frame-cost note if the decal budget changes.
- Needs a browser — and this one genuinely does. The list for the human: fire a magazine into a
  wall on Dunes and on Foundry; look at the crosshair against sand, against sky, and against a
  dark interior; and land hits on a bot at the edge of the map to check the hitmarker against
  bright ground.

---

# P10 — Bodies

Covers **F4**. Cosmetics only. This is the largest visual item in the round and the one to do last.

## The report

A torso box and a head. No arms, no legs, no walk cycle, no weapon in the hands. The
environment — brick, concrete, catwalks, awnings, hazard stripes — is at a noticeably higher
standard than the thing the player actually looks at, and that gap is what the eye catches.

Round 4's `R4-F4` asked for character skins and 3D models. This is deliberately the cheaper step
before it: not new models, but the parts that are missing from the one that exists.

## The order I want, and why

1. **The weapon in the hands.** The bot already has a resolved weapon def — `drawBotWeapon` gives
   each bot its own since the M7 hotfix — and `match.models` already builds weapon meshes for the
   viewmodel. Putting the right weapon in the right hands is mostly plumbing, and it is the
   single change that most makes a body read as a person rather than a shape. It also carries
   information the player can use: at distance, the silhouette tells you what you are about to be
   shot with.
2. **Arms and legs as boxes.** Four more primitives on a rig that already has an orientation.
3. **A walk cycle**, driven from the speed the renderer already has.

## The constraints, and they are the interesting part of this session

- **Nothing new on the wire.** The animation is a function of replicated state that already
  exists — position delta, yaw, stance, grounded. If you find yourself wanting to send a phase,
  stop: the phase is derivable, and deriving it is what keeps this inside the cosmetics boundary.
- **`check-cosmetics.mjs` must stay green.** A body's animation may not feed back into anything
  simulated, and in particular not into the hitboxes. If the legs move and the hitbox does not,
  that is correct and must be stated in `PLAN.md` so nobody later "fixes" it.
- **Cost scales with the roster.** Ten bodies, each gaining several meshes and a per-frame
  update. Instancing and a shared skeleton matter here in a way they did not for props.

## Verification

- `__operator.frameReport()` with a full 10-bot roster, before and after, 600 samples.
- `npm run leak` — the new meshes are released with the bot.
- `npm run check` green, cosmetics check green.
- Needs a browser — a bot walking across the frame at 5m, 20m and 50m, and a bot strafing while
  shooting, which is where a bad walk cycle shows.

---

# P11 — The first thirty seconds

Covers **F6, F7, F13**.

## Why these three are one session

They are what a player sees between clicking `PLAY MULTIPLAYER` and being in a real match, and
right now that stretch is the weakest sequence in the game:

1. F13 — `[join] no background build ready for mp_testbed; building it now (expect a hitch)`.
   The M11 promise is a transition with no loading screen. The code itself logged that it could
   not keep it.
2. F6 — the room they land in is nearly black. `R4-F9` framed this as "the third map"; the
   warmup arena is the more important instance, because everyone sees it and they see it first.
3. F7 — the first objective they stand in draws a flat, opaque, saturated green disc.

## Starting points

F13 is the one with a mechanism to find, and it is not a cosmetics item — start there.
`game.buildQueue`, `game.lastBuildReport` and the `[mapbuild] background build started` line are
the instrumentation that already exists. The question is precise: **on which transitions is the
prebuild started, and is `mp_testbed` one of them?** The observed line came after a rotation back
to the arena, which is plausibly the one path nobody prebuilds because the arena is supposed to
be permanent — and if that is it, then it is a missing case rather than a race, and the fix is a
case.

F6 is `def.ambient` and the lights in the testbed map definition. The bar is not "brighter"; it
is that a player can see the geometry, the dummies and the other players well enough to
understand where they are within a second of arriving.

F7 is `objectives` in `client/world/` — the fill, not the ring. The ring reads well already.
Translucent fill, and a pulse whose rate comes from the capture rate that is already computed,
so the disc is telling the player something rather than just being coloured.

## What I want out of this beyond three fixes

A sentence in `PLAN.md` describing, end to end, what happens between the click and the first
frame of the arena, and where each of the three fixes sits in it. That sequence is the game's
first impression and nobody has written it down.

## Verification

- `npm run skirmish` — assert the prebuild is ready at every rotation the flow passes through,
  including back into the arena. That assertion is the real deliverable of F13.
- `npm run check` green, cosmetics check green.
- Needs a browser — click `PLAY MULTIPLAYER` cold, and again after a rotation, watching for the
  hitch; and stand in a capture point on Dunes.

---

# P12 — What the HUD knows and does not say

Covers **F8, F9**.

## Two reports, one omission

In both cases the information exists in state and is not surfaced:

1. F8 — in Domination the top bar shows two scores and a timer. Which team holds A, B or C is
   readable only from the minimap. The objective banner (`HudStreaks.ts`, "the objective banner
   — the bomb timer, the plant/defuse ring, and the capture prompt") exists and works, but it is
   contextual: it appears when you are standing in a point, not when you are deciding where to go.
2. F9 — the death screen shows `YOU WERE KILLED` and a countdown. Who killed you, with what, and
   what health they had left is in the killfeed, in the corner, for a few seconds.

## What I want, and the shape it should take

**F8** is a persistent strip in the mode's own header, populated by the mode rather than by the
HUD — Domination has three points, Search & Destroy has two sites and a round count, Kill
Confirmed has tags. The right artefact is not "flags in the top bar" but a header slot the mode
registry fills, so the next mode does not need a new HUD component. Round 4's `R4-F10` already
established that a mode can describe itself to the player; this is the same idea, made permanent
instead of shown once.

**F9** is a panel the player reads while they are dead and have nothing else to do, and it should
carry what they can act on next time: the killer's name, the weapon, the distance, and the health
they had left. The last of those is the one that changes behaviour — "he had 8 health" is a
different lesson from "he had 100" — and it is also the one most likely not to be replicated yet.
Check before you promise it; if it is not on the wire, say so and decide whether it is worth
adding rather than adding it quietly.

## Verification

- Headless: the header model is a pure function of mode state, tested per mode without a DOM.
- `npm run check` green.
- Needs a browser — a Domination match with the flags changing hands, and three deaths in
  multiplayer, confirming the panel names the right killer and weapon.

---

# P13 — Level 1

Covers **F10**.

## The report

At level 1 there is exactly one primary weapon. Everything else is gated: Wasp 9 at 4, Vulcan 74
at 6, Breacher 12 at 9, Halcyon B5 at 12, Meridian P40 at 15, Kestrel .338 at 18, Longbow Mk3 at
20, Bastion 249 at 25, Monolith 60 at 32, Vantage SR at 38. All five classes therefore show
`M4 CARBINE`.

## Why this is worth a session on its own

`CREATE A CLASS` is one of the best screens in the game — a 3D weapon preview, a full stat table,
and perk modifiers called out in orange against the base value. A new player opens it in their
first minutes, finds one weapon and five identical classes, and learns that the screen is not for
them yet. That is the opposite of what the screen is for.

There is a second reason, and it compounds with B4 and B6: a new player's first match is
currently a loss against a VETERAN, paying zero XP, after which the only unlock is 500 XP away.
Three separate systems all answer "not yet" at the same moment.

## What I want decided

Which weapons open at level 1, and on what principle. My suggestion, to argue with rather than
implement: one per archetype the maps actually reward — the AR that already exists, an SMG, and
the shotgun — so that the first visit to the screen is a real choice between three feels, and so
that the five class presets can differ from each other on day one.

The unlock levels of everything else then need re-spacing rather than shifting, and the levelling
curve in `Levels.ts` is the other half of that conversation. Do not move one without looking at
the other.

## Verification

- Headless: a fresh profile has the intended weapons available and the intended ones locked.
- `npm run check` green.
- Needs a browser — reset progress, open Create a Class, and confirm the five presets are
  distinguishable from each other.

---

# P14 — Planning brief: deployment and the hidden tab

Covers **F11, F12**. **No game code.** This session produces a written plan and measurements, and
nothing else.

## F11 — the free plan, and what it costs

`render.yaml` sets `plan: free`, with the comment "the free instance has 512 MB and half a CPU".
Two consequences, both observed:

- Returning to the URL after a break gave a cold start of roughly 20 seconds on Render's own
  branded loading page, with a 503 in the middle. Not a screen of this game. Anyone sent the link
  who does not wait concludes it is broken.
- The permanent warmup arena and any live match are destroyed on every sleep. "Permanent" is a
  property of the process, and the process is not.

What I want written: what the paid tier costs, what it buys here specifically, and — if the
answer is "stay on free" — what the mitigation is. A keepalive ping is the obvious one and it is
worth stating honestly that it is against the spirit of the free tier. A branded holding page
served by something that does not sleep is another. There is no code in this session; there is a
recommendation with a number attached.

Also settle the region. `render.yaml` does not pin one, so the service uses the account default.
Measured RTT was 99.8ms with 0.29ms jitter and zero loss — a healthy link, but 100ms is a lot for
a shooter, and if the players are in Israel then Frankfurt is worth what it costs. Confirm where
the service actually runs before recommending a move; do not assume.

## F12 — the clock lag, and the honest version of it

In a **hidden** browser tab, the console showed a sustained run of:

    [netclient] 62 ticks behind the server clock; resynchronising.

dozens of lines, sitting between 55 and 63 ticks — around a second at 60Hz — and ending in:

    [netclient] server closed the connection: timeout

Read the caveat in "How this round was gathered" before you form a view. The tab was hidden, so
`requestAnimationFrame` was throttled, and a throttled client falling behind a 60Hz server clock
is the expected behaviour of the browser rather than a defect in this code. The early lines in
the same run were 6-16 ticks, which is what a live tab looks like.

So the question this session answers is not "fix the lag". It is:

1. **Reproduce it in a visible tab.** If the lag stays at 6-16, the game is fine and F12 closes as
   an environment artefact — write that down and close it.
2. **If it is throttling, is the response right?** `Game.onVisibility` exists. A client that knows
   it was hidden could re-anchor its clock once on becoming visible rather than resynchronising
   every tick and filling the console with warnings. Decide whether that is worth doing.
3. **The timeout is the part that matters to a player.** A tab left in the background gets
   dropped by the server. Reconnect works (`rejoined as entity 5` was observed), but the question
   is whether the player is told, and whether it happens silently and correctly when they come
   back to the tab. That is a real scenario — people switch tabs — and it is the one thing in
   F12 that is worth code, if any of it is.

## What this session produces

A section in `PLAN.md`: the deployment recommendation with costs, the region answer, and the
result of the visible-tab reproduction with the numbers it produced. If item 3 turns out to need
work, it becomes an item in round 6 with a written brief — not a fix made here.
