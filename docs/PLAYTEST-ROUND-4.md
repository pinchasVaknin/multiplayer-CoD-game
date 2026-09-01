# OPERATOR — Playtest round 4: the report, and the sessions that answer it

הדוח מסבב ה-playtest הרביעי, מפורק ל-11 סשנים + כללי עבודה משותפים. הפירוק **לפי סיבת שורש
ולא לפי סדר הדוח**: דיווחים שנראים שונים ומגיעים מאותו מנגנון יושבים באותו סשן.

---

## איך מריצים

סשן טרייה בתיקיית הפרויקט, ושורה אחת:

    Execute P1 from docs/PLAYTEST-ROUND-4.md

אין מה להעתיק. הקובץ נקרא מהדיסק — אז הוא צריך להיות שם, וכדאי לעשות לו commit אם אתה
עובד בענף אחר.

---

## How a session here is run

You have been asked to execute one of the sessions below — P1 through P11. Only that one.

Everything you need is in this file: the report as it was written, in "The report, verbatim";
the rules that bind every session, in "P0 — Ground rules"; and your own brief.

**Read "P0 — Ground rules" in full before you touch code, and treat every rule in it as
binding.** It is not preamble: it says what counts as a fix here, what is banned, what the gate
is, what you may claim to have verified, and what you must produce before the session ends.

One session per fresh session. The only handover between them is `PLAN.md` and this file.

---

## מפת הסשנים

| # | נושא | פריטי הדוח | תלוי ב־ |
|---|---|---|---|
| P0 | Ground rules — חלות על כל סשן | — | — |
| P1 | UI surfaces and the keys they hold | B1, B6, B13 | — |
| P2 | The summary screen and the way back | B4 | — |
| P3 | The loadout doctrine | B5, B8, B11, B7, F15 | — |
| P4 | Killstreaks as a currency | B9, B10 | — |
| P5 | Grenades: the per-life reset, in every mode | B3 | P4 |
| P6 | The waiting room and the edges of a match | F7, F11, F12, F13 | — |
| P7 | Cheat codes and the debug gate | F14 | P1, P3, P4 |
| P8 | Reconnect and join-in-progress | F8 | — |
| P9 | Reading the fight | B2, B12, F9, F2, F3 | — |
| P10 | Bot difficulty and the mini-tutorial | F1, F10 | — |
| P11 | Planning brief: the large content (no code) | F4, F5, F6, F16, F17 | — |

סדר: P1 → P2 → P3 → P4 → P5 → P9 → P6 → P8 → P7 → P10 → P11.

---

## The report, verbatim

Hebrew as reported, with an English gloss. The prompts refer to these ids.

### Bugs

- **B1** — סגירה ופתיחה של הדיבאג: האיקס לא תמיד עובד - לחיצה סוגרת אותו, אבל כשחוזרים למשחק הוא נפתח מחדש.
  *The debug overlay's × closes it, but returning to the game reopens it.*
- **B2** — כוונת סגורה ברובה מסוים מסוג AR.
  *The crosshair is closed/absent on one particular assault rifle.*
- **B3** — רימונים: מלאי הרימונים לא מתחדש לאחר מוות/פסילה (קורה במודים מסוימים).
  *Grenade stock is not refilled after death or elimination, in certain modes.*
- **B4** — מסך סיום משחק: בעיות בכפתורים – צריך שיהיו 2 כפתורים (יציאה למסך הבית ומשחק חוזר). כרגע צריך ללחוץ פעמיים, הטיימר תקוע על 14 שניות, והכפתור זורק לתפריט הראשי במקום ללובי.
  *End-of-match screen: wants two buttons (exit to home, and rematch). Today the first click is eaten, the countdown sits at 14, and the button leaves to the main menu instead of the lobby.*
- **B5** — מסך בחירת Class: להחליף שם את הכפתור יציאה למאצ' לכפתור של שמירה ויציאה והוא ישלח לMenu הראשי.
  *In Create-a-Class, replace the "exit to match" button with "save and exit", going to the main menu.*
- **B6** — פתיחת טאב (Tab) נשארת פעילה/נתקעת ב-Multiplayer בזמן שמתים.
  *The Tab scoreboard sticks open in multiplayer while dead.*
- **B7** — בחירת רימון גז: לא מסומנת רמה.
  *The gas grenade shows no unlock level in the picker.*
- **B8** — חנות נשקים בזמן משחק: יש גישה לשינוי מה-Pause Menu. צריך לבטל זאת ולהגביל את השינוי רק דרך מקשים 1-5.
  *Loadout changes are reachable from the pause menu mid-match. Remove that; in-match changes only via keys 1-5.*
- **B9** — KillStreak (תצרוכת): הפעלת יכולת צריכה "לעלות" בהריגות (לדוגמה, אם השגתי 12 הריגות והפעלתי משהו שעולה 6, יישארו לי 6 הריגות ולא אוכל להפעיל משהו שעולה 8).
  *Activating a killstreak must cost kills: 12 earned, spend 6, 6 left — and an 8-cost streak is then unaffordable.*
- **B10** — KillStreak (זמינות): ברגע שהופעל KillStreak מסוים, אי אפשר להשתמש בו שוב עד איפוס של מוות.
  *A killstreak, once used, cannot be used again until death resets it.*
- **B11** — חנות נשקים (UI): כשבוחרים נשק, הרשימה קופצת חזרה להתחלה (בוחר נכון פיזית, אבל ויזואלית לא נראה טוב).
  *Selecting a weapon scrolls the list back to the top. The selection itself is correct.*
- **B12** — צבעי קבוצות: ב-Multiplayer יכול לקרות שאני אצא עם אדומים, מה שמבלבל כי בדרך כלל אדום מסמן אויבים.
  *In multiplayer you can end up on the red side, which reads as "enemy" and confuses.*
- **B13** — ריבוע שינוי דמות: הריבוע בצד לא נעלם לאחר תחייה (Respawn).
  *The quick class-select panel does not disappear after respawn.*

### Additions, changes, upgrades

- **F1** — אפשרות להתאמת רמת הקושי של הבוטים. *Bot difficulty selectable.*
- **F2** — חץ סימון שיצביע על הפצצה להרמה. *A marker arrow pointing at the bomb to pick up.*
- **F3** — עיצוב תג מציאותי: הפיכת ההולוגרמה של התג לממשית ומסתובבת. *Dog tags: from hologram to a solid, rotating object.*
- **F4** — הוספת סקינים ומודלים 3D לדמויות. *Character skins and 3D models.*
- **F5** — פיתוח עלילה למשחק. *A story.*
- **F6** — הוספת שלבים. *More maps.*
- **F7** — לובי טרום-משחק: לבטל את האפשרות למות באזור ההמתנה, ולהוריד משם דירוג ותוצאות. *Pre-match lobby: no dying there, and no scoring or results.*
- **F8** — מערכת Reconnect / הצטרפות למשחק פעיל במקרה של ניתוק. *Reconnect and join-in-progress.*
- **F9** — תאורה: המגרש השלישי חשוך מאוד, צריך לסדר בו את התאורה. *The third map is very dark.*
- **F10** — הדרכה/Mini-Tutorial: הוספת הסבר קצר לכל משחק (למשל: מה מטרת המשחק או לאן לקחת את הפצצה). *A short per-mode brief.*
- **F11** — UI הגדרות (Settings): לפתוח את תפריט ההגדרות במרכז המסך. *Settings should open centred.*
- **F12** — חדר המתנה: הוספת כיתוב "ממתין" במרכז למעלה במסך. *A "waiting" caption, top centre, in the waiting room.*
- **F13** — סאונד: הוספת צליל כאשר אפשרות בחירת המגרש מופיעה. *A sound when the map ballot appears.*
- **F14** — קודי צ'יטים וממשק הדיבאג: `DEBUG666` מפעיל דיבאג (יש להוריד את הדיבאג מהאפשרויות הרגילות); `SPEC[]1` God mode; `SPEC[]2` Invisible; `SPEC[]3` Free cam; `SPEC[]4` Full spectator; `MO951357` מעניק 30 הריגות ישירות לטובת ה-KillStreak (ללא ספירה בתוצאות המשחק).
  *Cheat codes, and the debug overlay moves behind one of them.*
- **F15** — UI נשקים: הפיכת הבחירות הטכניות לויזואליות (נראה את הנשק שבוחרים). *The weapon picker should show the weapon.*
- **F16** — Killstreaks חדשים: מיניגאן, להביור, מגן-אקדח. *New killstreaks: minigun, flamethrower, riot shield + pistol.*
- **F17** — אנימציה: זריקת רימון ויזואלית מפורטת (תנועת יד, פתיחת נצרה וכו'). *A detailed grenade-throw animation.*

---

# P0 — Ground rules

Binding on every session below.

## Read before you touch code

1. `PLAN.md`, from `# M11 Gate B — in progress` to the end of the file. That is playtest
   rounds 1-3: what was reported, what it turned out to be, and what was measured. The
   sections "One entity id was behind three of them" and "Playtest round 3" are the model
   for what good work looks like here.
2. `docs/PLAYTEST-ROUND-4.md` — this report in full. Your session is one part of it.
3. `package.json` — the scripts are both the gate and the instruments. Read the `//` notes.

## The rules

**1. Root cause, not a plaster.**
Before you write a line, put the mechanism in one sentence: *"the symptom exists because X."*
If you cannot write that sentence you do not yet understand the bug — keep reading. A fix that
removes the symptom without naming the mechanism is rejected.

Explicitly banned, even when they work:

- a timer or delay to let state "settle";
- a new boolean beside existing state instead of deriving from the state already there;
- a second writer that undoes the first — something that re-hides, every frame, what something
  else keeps showing;
- an `if (networked)` branch duplicating a rule that already exists elsewhere;
- a `try/catch` that swallows;
- a magic number tuned until the observation stopped.

The shape that is allowed is the opposite: **one writer, and a value derived from state that
outlives the surface displaying it.**

**2. Look for the shared cause.**
If your session carries several reports, ask whether they are one mechanism before fixing each
separately. It has already happened twice here: one `entityId` behind three complaints, and one
stale overlay that also ate keypresses.

**3. Do not believe `PLAN.md` when it says "fixed".**
This report post-dates everything in it. Where PLAN claims something was fixed and the human
still sees it, your first job is to explain **why the fix does not reach the path they played** —
networked vs solo, a call site that does not exist, a second writer. Only then fix. Do not
re-fix what is already fixed.

**4. Authority: a fact that moved to the server breaks every reader of the local copy, silently.**
That is this milestone's recurring failure. When you touch a fact the server owns, walk every
reader of it, not only the one that was reported. And when something is "implemented but not
verified", the first suspect is that it has no caller at all: trace call sites before you blame
logic.

**5. Boundaries.**
`shared/` compiles without the DOM lib — a stray `document` there is a compile error, not a
runtime bug. The client/server/shared partition is enforced by `scripts/check-boundaries.mjs`,
which runs first for a reason. Cosmetics do not touch simulation; `scripts/check-cosmetics.mjs`
fails if they do.

**6. The gate.**
`npm run check` (boundaries + cosmetics + all three typecheck targets) must pass before you
commit. Anything touching simulation or the wire also runs the relevant harness:

- `npm run harness` — local simulation, N matches
- `npm run netharness` — headless clients against a real server
- `npm run skirmish` — the full flow: connect, warmup, vote, migrate, match, return
- `npm run leak` — 100 allocate/destroy cycles; heap and live EventBus subscriptions flat

If you changed the wire format, bump the protocol version and say so (precedent: v6, v7, v8).

**7. The verification split, and it is hard.**
You measure headlessly. The human plays and reports feel. **Never invent a number.** Every
number in your summary must come out of a run you did in this session, named with the probe
that produced it.

What headless cannot verify, say you did not verify. `HeadlessClient` drives `NetClient` and
`Prediction` directly and builds no `ClientMatch` at all, so any claim about the HUD, about
input, or about what appears on screen is untested even when the harness is green. The preview
pane here never fires `requestAnimationFrame`, so do not claim visual verification through it.
End every session with an explicit **"needs a browser"** list with exact reproduction steps.

**8. Scope.**
Fix only the items in your session. If you meet an adjacent defect: if it is the same cause, fix
it and say so; if it is not, record it in `PLAN.md` under "Found while here" and leave it.

**9. What you produce.**

- A section in `PLAN.md` in that file's voice — it is written as prose, not as ticket bullets:
  what was reported, what the mechanism was, what changed, what was measured and by how much,
  and what still needs a browser. If you reversed an earlier decision, **rewrite the old
  section** so the record does not contradict itself.
- One commit, in the style already there — a sentence describing what was found, not
  `fix: ...`. Run `git log --oneline -10` and match it.

**10. Language.**
Code, comments, `PLAN.md` and the commit message: English, in the existing voice. The closing
summary to the user: Hebrew.

## How to start

Plan first. For each item in your session write the hypothesis sentence — *"the symptom exists
because X"* — and the call sites you will read to confirm or kill it. Show that list before you
write code.
---

# P1 — UI surfaces and the keys they hold

Covers **B1, B6, B13**.

## Three reports, one shape

1. B1 — "the debug overlay's × does not always work: clicking closes it, but coming back to
   the game reopens it."
2. B6 — "the Tab scoreboard sticks open in multiplayer while I am dead."
3. B13 — "the quick class-select panel on the left does not disappear after respawn."

A hypothesis for you to test, not to adopt: all three are the same shape. A visible surface
whose visibility is written in two different places, or is not written at all at the moment it
needed to change. Round 3 already established half a rule here — "a hidden surface never
consumes a key" — and the other half is missing: **a surface that has stopped being shown must
release what it latched.**

## Starting points

B1: `src/client/debug/DebugOverlay.ts` — `setVisible` (around line 386) is the only writer of
`root.hidden`, and the × button calls it (line 189). Find who else turns it on: `PauseMenu`
exposes a "Debug overlay" button (`src/client/ui/PauseMenu.ts:60`) calling `onToggleDebug`, and
`DebugSuite` constructs the overlay (`src/client/debug/DebugSuite.ts:153`). The precise
question: when the human clicks ×, which copy of "is the debug overlay open" is updated and
which is not — and what re-shows it on the transition back into MATCH. `Game.ts` reacts to state
transitions; look there for a setVisible/toggle on entry.

B6: `src/client/ClientMatch.ts:1350` —
`this.ui.setScoreboardOpen(isDown(cmd.buttons, Btn.Scoreboard))` is derived from the sampled
command every tick. If that path stops running while the player is dead on a networked client,
or input sampling is gated on `alive`, the last value sticks: a latch with no reset. Check
`MatchHud.ts:97,100,141` too, and `ALWAYS_PREVENT` in `src/client/input/Input.ts:33`, which
includes 'Tab' — if the preventDefault continues but the consumer does not, that also explains
why Tab feels "held".

B13: `src/client/Game.ts:985 updateQuickLoadout()`, called from `Game.ts:1871`, derives the
window from the respawn countdown. Round 2 measured that window correct end to end — the table
in PLAN.md, "The class panel's own window, measured". So the suspect is not the derivation but
its input: either `updateQuickLoadout` is not called on the frame the respawn lands, or the
countdown it reads never clears on this path (a local respawn value a networked spawn does not
touch). Determine which, by measurement rather than by reading.

## What I want out of this beyond three fixes

**One written invariant:** every HUD surface has exactly one writer, and its visibility is a
pure function of state that outlives the surface, evaluated once per frame from one place.
Extract `QuickLoadout`'s window predicate (and its equivalents) into pure functions testable
headlessly without a DOM — that turns "the panel disappears on time" from something you look at
into something you measure.

**And a table in PLAN.md:** every HUD surface (scoreboard, quick loadout, debug overlay, vote
overlay, pause, summary, mortar overlay), its single writer, the condition it is derived from,
and what it consumes from input. That table is the artefact that stops this class of bug coming
back.

## Verification

- Headless: the extracted predicates over a state sequence that includes death, respawn, round
  end and migration.
- `npm run skirmish` and `npm run check` green.
- Needs a browser — write the list for the human with steps: × on the debug overlay then
  Escape then back into the game; Tab held across the moment of death and after it; waiting out
  a respawn with the panel open.

---

# P2 — The summary screen and the way back

Covers **B4**.

## The session

B4, as reported: the end-of-match screen should have two buttons — exit to the home screen, and
rematch. Today the first click is eaten so it takes two, the countdown sits at 14 seconds, and
the button leaves to the main menu instead of returning to the lobby.

## Read this first, and treat it as a problem in itself

PLAN.md, round 2, "The summary screen was a dead end with a stuck clock" claims all three were
fixed: the timer ticks from the render pass, the button returns to the game when connected
rather than going to MENU, and the SUMMARY exit handler no longer tears the world down when
`to === 'MATCH'`.

The human still sees all three. **Your first job is not to fix but to explain why that fix does
not arrive.** Candidates to kill by measurement: `setReturnSeconds`
(`src/client/ui/EndOfMatch.ts:91`) is only called from a path that does not run in SUMMARY; the
render pass does not advance there at all; the `networked` flag (line 118) is not set on the
real path, so both the wording and the destination fall back to single-player; or the value fed
in is the initial hold rather than the remainder the server is holding.

## Three pieces of work

**1. The timer.** The number on screen must be the hold **remaining on the server**, not a local
guess and not a value written once. If the server does not send it, that is what is missing —
add it, and bump the protocol. A client that counts for itself leaves early and stands in a
world that has been torn down; that reasoning is already in the file, honour it.

**2. The double click.** The first click is being eaten. Suspects: the input focus guard
(`Input.domFocusGuard`, referenced at `src/client/ui/PauseMenu.ts:93`), pointer lock being
released or re-acquired at the transition into SUMMARY, or a button receiving the click before
the screen has actually taken focus. Do not fix this with a `setTimeout` and do not add a second
listener. Find who swallows the first event.

**3. Two buttons, and what "rematch" can honestly mean here.**
Against a dedicated server there is no client-side rematch: the server migrates everybody back
to the arena, and the vote cycle running there *is* the rematch. So:

- Ship two buttons. The primary returns to the lobby/arena without disconnecting — the seat, the
  socket and the world all survive (this is exactly what round 2 built; you are confirming it
  actually works). The secondary exits to the main menu and disconnects.
- If it turns out both buttons would do the same thing, **do not ship two buttons that do the
  same thing.** Say so explicitly in your summary and propose the honest version: either a real
  rematch as a ballot in the cycle, or one primary button plus an exit.
- Single-player must not regress: there "Continue" really is a continue.

## Verification

- Headless: `npm run skirmish` — the time from match end to the actual migration, against what
  the screen is supposed to show. Print both.
- Needs a browser: the first click lands; the number counts down; returning to the lobby keeps
  the connection alive (check in NetPanel that it is the same socket); exiting to the menu really
  disconnects.

---

# P3 — The loadout doctrine: when a class may change, and where

Covers **B5, B8, B11, B7, F15**.

## The session

- B5 — in Create-a-Class, the "exit to match" button becomes "save and exit", going to the main
  menu.
- B8 — loadout changes are reachable from the pause menu mid-match. Remove that. In-match, keys
  1-5 are the only way to change class.
- B11 — selecting a weapon scrolls the list back to the top. The selection itself is correct.
- B7 — the gas grenade shows no unlock level in the picker.
- F15 — the weapon picker should be visual: you see the weapon you are choosing.

## The rule that unifies B5 and B8, and what it reverses

This is not a bug, it is one design decision: **the editor is a front-end screen; inside a match
the only way to change class is 1-5.**

And it **reverses an earlier decision**, so do not do it quietly. PLAN.md, round 2,
"Create-a-Class was a state where it should have been an overlay" describes making the editor an
overlay over a live match, deliberately. The human is now asking for the opposite. Do three
things:

1. Remove the entry point at `src/client/ui/PauseMenu.ts:56` and every other route into the
   editor from inside a match.
2. **Keep what is still needed from that work** — the deferral of `meta.setLoadout` that prevents
   the `PlayerController.speedScale` divergence (Tier 1 #20). It protects the 1-5 path too, and
   that path is now the only one. Do not tear it out along with the overlay.
3. Rewrite that PLAN.md section so the record does not contradict itself: what it was, why it
   changed, and what survived.

B5 falls out of this: if the editor is reachable only from the front end, "save and exit → main
menu" is the only destination there is. Make sure the save is explicit and complete
(Profile/SaveStore) *before* the transition, and that no route leaves without saving.

## B11 — the list that jumps

Almost certainly the cause is that selecting re-renders the whole list instead of updating the
rows that changed, and the new DOM starts at `scrollTop = 0`. **The fix is not to save and
restore `scrollTop`** — that is the plaster. The fix is that selection is a class toggle on rows
that already exist. Preserved scroll position is the *test*, not the solution.
`src/client/ui/LoadoutEditor.ts`.

## B7 — the level that is not marked

Find where tactical equipment shows its unlock level (`src/shared/meta/Unlocks.ts`,
`src/shared/meta/Levels.ts`, `src/shared/equipment/EquipmentDefs.ts`, and the consumer in
LoadoutEditor). Hypothesis: the UI reads a table, the gas grenade has no row, and so it draws
nothing. If that is what it is, do not stop at adding the row — **make a missing row loud.** A
startup validation, or a check in the style of `scripts/check-cosmetics.mjs`, that every defined
weapon, equipment item and streak has an unlock record. That is this project's habit: turn a
class of bug into a check that fails.

## F15 — the visual picker

Render the real weapon model in the editor, from the same builder the viewmodel uses
(`src/client/weapons/WeaponMesh.ts`, `WeaponMeshParts.ts`, `WeaponModelSpecs.ts`) — **one source
for what a weapon looks like.** Note that `src/client/ui/WeaponIcons.ts` is already a second
source that can drift; decide what happens to it and say so. This project has no asset files at
all (no png, glb or wav — everything is procedural), so do not invent an asset pipeline in this
session.

## Verification

- `npm run check` green, including the new unlock-table check.
- Headless: no code path reaches the editor from MATCH or PAUSED — prove it by grep, not by
  impression.
- Needs a browser: the list does not jump; the gas grenade shows its level; the weapon is
  visible; 1-5 still works and has not moved.

---

# P4 — Killstreaks as a currency, not a threshold

Covers **B9, B10**.

## The session

- B9 — "activating an ability must cost kills: if I have 12 kills and activate something that
  costs 6, I am left with 6 and cannot then activate something that costs 8."
- B10 — "once a given killstreak has been used, it cannot be used again until death resets it."

## What this actually is: a different model, not a defect

Today streaks are activation thresholds on a consecutive-kill counter (`PlayerScore.streak`; see
`src/shared/streaks/StreakSystem.ts`, whose comment at line 81 says it outright: someone who
reached twelve kills holds six things and can spend three of them). **A threshold is not a
currency**: crossing 12 opens everything priced at or below 12 at once, and spending one does not
move the counter.

What the human describes is a **balance**: kills accumulate, activation debits the price, death
zeroes the balance, and each streak is once per life. Implement that, and write in PLAN.md what
changed about the economy and what it does to pacing — this is a balance change, not a UI change.

## Where it has to live

The balance is a fact the server owns. The client's `StreakSystem` is deliberately never
simulated over the network (PLAN, round 2: "fires into the copy of StreakSystem that is
deliberately never simulated"), so:

- The debit happens on the server, through one door — the same `spendStreak` round 2 introduced.
  If another caller reaches `activate` and bypasses it, that is a bug in its own right; find it.
- The balance, the prices, and the "already used this life" set come down in the snapshot. Bump
  the protocol.
- Bots spend through the same debit path, or bots and humans live in two different economies.

## Details that need an explicit decision, not a silent default

- **Death.** `StreakSystem` line 454 already says "Dying costs the streak and everything earned
  but not spent". Under the balance model that stands: death zeroes the balance and clears the
  used set — which is what "until death resets it" in B10 means.
- **Care packages** (line 392) hand their contents over "unearned". Decide: free gift, or debited
  from the balance. Justify it.
- **Perks that touch streaks** (Ghost and friends) must stay consistent with the balance.
- **HUD.** `src/client/ui/HudStreaks.ts` paints three states today (empty, owned-but-unearned,
  ready). There are now four: "used this life". The price has to be on screen, or a player cannot
  plan a purchase. Keys 3/4/5 keep indexing the class's three slots (round 2), not the earned
  list.
- **The score counter is not the balance.** That separation must be explicit in the code, because
  F14's `MO951357` cheat adds 30 to the balance without touching match results. If the balance is
  a read of `PlayerScore.kills`, that cheat is impossible to implement cleanly — and that is the
  signal the model is wrong.

## Verification

- A headless probe printing, per player and per life: earned, spent, balance, used-set. Show that
  `balance = earned − spent` holds, that it is never negative, and that both are zero after
  death. That is a measurement, not an assertion.
- `npm run harness` and `npm run skirmish`: how many streaks were activated per match before and
  after, same seed. If the number drops, that is expected — say by how much and let the human
  decide whether that is the intended balance.
- Needs a browser: the HUD, the balance decreasing on activation, and a used streak's key doing
  nothing while saying why.

---

# P5 — Grenades: the per-life reset, in every mode

Covers **B3**.

## The session

B3 — "grenade stock is not refilled after death or elimination; it happens in certain modes."

## Why this still happens after round 2 fixed it

`src/client/MatchEquipment.ts` already contains exactly that fix: `onSpawned` (line 476) calls
`refillForLife` (line 498), and the comment at line 487 explains that a networked respawn emits
no `player.spawned` at all, which is why the refill was split into its own function. The human
says "in certain modes" — and that is the clue: there are new-life paths that go through neither
door. The immediate suspects are round-based and elimination modes: `SearchAndDestroy`, where a
new round is a new life with no respawn, and any path that starts a round from `MatchFlow` or
`src/server/instance/`.

## The rule I want built, not a third call site

Do not add a third call to `refillForLife`. Instead: **one signal that says a new life started**,
and the server already holds it — the spawn serial it bumps (PLAN, round 2, on
`applyPendingLoadoutNow`: "the spawn-serial bump is the same discontinuity a death already
produces"). Every per-life reset hangs off that one signal, rather than each subsystem listening
for an event of its own.

Then count them and put a **table of every per-life fact** in PLAN.md: grenades, tactical
equipment, the field-upgrade charge, perk state, the "streaks used this life" set from P4,
health, the streak counter. For each: who resets it, and from which signal. Any row still
listening to a different event is the next bug.

## Verification

- A headless probe running every mode (TDM, FFA, Domination, Kill Confirmed, S&D) and printing
  grenade stock at the start of every life or round, for every player. The claim I want a number
  for: N life-starts examined, 0 with partial stock. If there were X failures before the fix,
  print that too — the red control before the green.
- `npm run check` green.
- Needs a browser: the HUD count after a respawn and at the start of an S&D round.

---

# P6 — The waiting room and the edges of a match

Covers **F7, F11, F12, F13**.

## The session

- F7 — the pre-match lobby: no dying in the waiting area, and no rating or results there.
- F12 — a "waiting" caption, top centre of the screen, in the waiting room.
- F13 — a sound when the map ballot appears.
- F11 — the settings menu should open centred on screen.

## F7 — and this is a spec change, not a fix

`src/server/instance/WarmupMatch.ts`, lines 19-20, quotes §6.3: the room is "free-for-all rules
with damage live and instant respawn, no score and no win condition". The human now wants no
dying there at all. Make that change **deliberately**: update §6.3 inside PLAN.md so the spec and
the code say the same thing.

And keep a distinction that must survive: "damage live" and "players killable" are two different
facts that were one flag. The training targets (`TargetDummy` / `TargetRange`) must keep taking
damage, or the waiting area stops serving its purpose. So: player-to-player damage does not take
health (or is not computed at all — decide which, and justify it in terms of what the client
predicts), while dummies still do.

"No rating and results" — confirm the room feeds no XP, progression, scoreboard or challenges.
Trace `ScoreSystem` and `MatchProgression` from the warmup path and report what you found. The
comment at line 90 about `populatesRoster` is a good place to start.

## F13 — a trap I want you to avoid up front

Vote state is broadcast at 4 Hz (PLAN, round 3: "the server broadcasts ALLOCATING at 4 Hz"). A
sound played on receipt of state will play four times a second. **The sound must be
edge-triggered on the phase transition, not level-triggered on the broadcast.** The general form:
any effect hung off a periodic broadcast must hold the previous phase and fire only on the
change. Use `src/client/engine/AudioSpecs.ts` / `ProceduralAudio.ts` — everything here is
procedural, there are no sound files in the project.

## F12 and F11 — placement, not margins

The "waiting" caption is a top-centre banner. There is already a convention for centred-above-
the-crosshair text (`src/client/ui/HudBanner.ts:126`, `HudStreaks.ts:139` — "the objective
banner, centred above the crosshair"). Use it rather than creating a new surface, and state who
its single writer is (see P1).

The settings menu (`src/client/ui/Settings.ts`) does not open centred, almost certainly because
it is rendered inside a screen container rather than as a modal. Fix the placement rule, not with
fixed margins or offsets. Check `tokens.css` / `app.css` for the convention that already exists
for overlaid screens and honour it.

## Verification

- Headless: a warmup match where a bot shoots the player — health does not drop, no score row is
  created, no XP accrues. Print all three numbers. Also: how many times the ballot sound fires
  per cycle — it must be 1, not 4 × duration.
- `npm run skirmish` and `npm run leak` green (the room is also what the leak harness builds
  empty).
- Needs a browser: the caption is where it should be; settings open centred; the sound plays
  once.

---

# P7 — Cheat codes, and the debug gate

Covers **F14**. Run after P1, P3 and P4.

## The session

The codes requested:

- `DEBUG666` — enables the debug overlay. And with it: remove the debug overlay from the ordinary
  options.
- `SPEC[]1` — god mode
- `SPEC[]2` — invisible
- `SPEC[]3` — free cam
- `SPEC[]4` — full spectator
- `MO951357` — grants 30 kills toward killstreaks, not counted in match results.

## The most important thing in this session

God mode, invisibility and spectator change what the simulation says. Against a dedicated server,
**a client granting itself those is an exploit, not a cheat code** — it either does nothing (the
server keeps killing you) or, worse, it works and is a hole. So:

- The code goes to the server. The server decides.
- The server accepts it only if configuration allows: a flag in `src/server/Config.ts`, sourced
  from the environment, **off by default**. `deploy/operator.env` and `DEPLOY.md` need to know
  about it.
- If the server refuses, the client says so. A cheat that is silent when refused is a bug that
  will be reported twice.
- Free cam and full spectator already half exist: `src/client/debug/Spectator.ts`,
  `SpectatorPanel.ts`, `src/shared/modes/SpectatorTarget.ts`. Use them; do not write a second
  camera.

## The structure, not a pile of booleans

One entitlement store: a code is **input**, an entitlement is **state**, and every effect reads
the entitlement. No effect ever asks "was the code typed". That is what lets the server be the
source of truth, and what lets everything be turned off in one line.

The input is a key-sequence detector. Both rules from P1 and round 3 apply to it in full: it does
not consume a key meant for somebody else, and it is not live when its surface is not shown. Note
that the `[]` characters in `SPEC[]n` are not ordinary keystrokes — decide exactly what is typed
and document it for the human in your summary. If a text field is the better answer than a key
sequence, say so and propose where it goes.

## DEBUG666 and taking debug out of the menu

After P1 and P3 the pause menu is already changing. Here it also loses "Debug overlay"
(`src/client/ui/PauseMenu.ts:60`); the overlay becomes reachable only through the entitlement.
Confirm the × from P1 still works and has not become the only way out — Escape still closes it
(`DebugOverlay.ts:556`).

## MO951357, and the test it constitutes for P4

The code adds 30 to the killstreak balance without touching match results. If P4 derived the
balance from `PlayerScore.kills`, this code cannot be implemented cleanly — and that is the
signal the separation there is wrong. If you hit that, say so in your summary and do not fake it
with a compensating deduction in the score.

## And one more thing, because it saves the next playtest round

When a cheat is active, make it visible — a tag on the HUD and a line in the server log.
Otherwise a future bug report cannot be attributed: nobody can tell whether the player was in a
normal state.

## Verification

- Headless: the server refuses every code while the flag is off (print N attempts, N refusals);
  accepts while it is on; god mode genuinely survives a damage tick on the server; invisible
  actually removes the player from bot perception (`src/shared/ai/Perception.ts`) and not just
  from rendering.
- `npm run check` green. If the wire changed, bump the protocol.
- Needs a browser: typing each code, `SPEC[]n` included, and moving between the modes.

---

# P8 — Reconnect and join-in-progress

Covers **F8**.

## The session

F8 — reconnect, and joining a match that is already running, after a disconnect.

## What exists already, and what is missing

The server has the skeleton: `src/server/net/Session.ts:111` ("A reconnect reseats the session,
and reseating sends a seat assignment") and line 271, which discusses the reconnect grace and the
case where it failed to hold a seat. `src/server/serve.ts:76` mentions a reconnect loop. Start by
reading all three and writing down what **actually** happens today when a client drops mid-match
— measured, not taken from the comments.

What is probably missing, and is the session: an identity the client can present on return; a
grace window with a decision about the body in the meantime; a full resync on return (snapshot,
mode state, the balance from P4, the equipment from P5, the score); and join-in-progress — a
client connecting while a match runs should land in the live instance, not the arena.

## The decisions I want written before any code

- **Identity.** What identifies a returning seat, and how long it is held. Remember this is also
  an attack surface: anyone who can guess a token can take a seat.
- **The body during the gap.** Frozen, killed, or taken over by a bot. This project already has
  bot replacement (§6.7 / §8.27 in PLAN) — if a bot takes the seat, the return must take it back,
  without changing the player count mid-match.
- **Score and progression.** Preserved across the return. If not, that is a penalty for
  disconnecting, and you should say that is the decision.
- **Failure.** The grace expires → you join as a new player, and the user is told.

## Verification, and this is a session that measures well

The skirmish harness runs real headless clients. Add the ability to drop and re-dial. Measure:

- N disconnect/return cycles: how many kept the seat, how many kept the score.
- Resync time, from connect to the first synchronised frame.
- Divergence after return — the checker already exists (`src/shared/debug/DivergenceChecker.ts`,
  protocol v8). A returning client is exactly the case it should be speaking about.
- `npm run leak` — repeated disconnects are a classic source of leaked subscriptions.

---

# P9 — Reading the fight

Covers **B2, B12, F9, F2, F3**.

## The session

- B2 — the crosshair is closed or absent on one particular assault rifle.
- B12 — "in multiplayer I can end up on the red side, which is confusing because red normally
  means enemy."
- F9 — the third map is very dark. (Third in the ballot is `mp_depot` — see
  `src/shared/net/Skirmish.ts:119`.)
- F2 — a marker arrow pointing at the bomb to pick up.
- F3 — the dog tag: from hologram to a solid, rotating object.

## B2 — two hypotheses, both decidable by reading

1. The crosshair gap is the spread cone projected onto the screen
   (`src/client/ui/Hud.ts:473`). A weapon with an unusually low base spread draws a closed cross.
   Check `src/shared/weapons/defs/assaultRifles.ts` against `docs/BALANCE.md` for an outlier in
   the family.
2. The scope layer takes the reticle away (`src/client/ClientMatch.ts:1237`: "the scope overlay
   saw a scoped sniper and took the reticle away"). An AR with an optic that is misclassified as
   scoped loses its crosshair entirely.

Decide which one happened and fix that one. If it is the first, I want a **floor** as well: the
crosshair never collapses below a legible minimum, because an invisible reticle is a readability
defect rather than a balance choice. Document the floor.

## B12 — the rule that broke

`src/client/ui/Palette.ts` is already built correctly: friendly and hostile are relative to the
viewer, with three colourblind modes. The report says that somewhere an **absolute** team-to-
colour mapping leaks through (team A = red) instead of a viewer-relative one. Audit every place
that maps a team to a colour: scoreboard, minimap, nameplates, killfeed, HUD, objectives, the
vote overlay. The rule to write down and enforce: **colour is a function of (viewer's team,
subject's team), never of the team id alone.** If that can be enforced by types — not exposing an
absolute team colour outside `Palette` at all — that beats a comment.

## F9 — there is a precedent here, use it

`src/shared/world/maps/foundry.ts:456` documents exactly this fix from M5: "the problem was not
the key light — it was the fill". Do the same analysis on `depot.ts` rather than multiplying
everything up. Print the lighting values before and after as numbers in PLAN.md. Whether it
*looks* right needs eyes: that goes on the human's list, with a screenshot.

## F2 — the bomb arrow, and why it departs from an existing rule

`src/client/MatchObjectives.ts:15` and `:41` deliberately establish that objective markers are
**world geometry, not HUD markers**, and "Ghost is an intel filter" leans on that. A HUD arrow
pointing at the bomb departs from that rule. Two legitimate routes:

(a) an off-screen indicator on the HUD — in which case use the mechanism that already exists for
    hit direction (`HudTactical.showHitDirection`, line 318), one component for both uses rather
    than two that will drift;
(b) a world-space beacon visible through geometry.

Choose, justify it in writing against the `MatchObjectives` rule, and update that rule where you
departed from it. Either way: what is shown must respect the intel filter, or you have built a
legitimised wallhack.

## F3 — the tag

Cosmetic only. `src/shared/modes/KillConfirmed.ts` (tags are records rather than world entities —
line 37) and the client-side rendering. It must pass `npm run check:cosmetics`: appearance does
not touch simulation, and it does not touch the pickup radius.

## Verification

- Headless: the spread/crosshair numbers for every weapon in the AR family, before and after; the
  list of every team→colour site found and what was done at each; depot's lighting values.
- `npm run check` including cosmetics, green.
- Needs a browser, with screenshots: the crosshair on the reported rifle; the third map lit; my
  team's colour while I am on the "red" side; the arrow; the tag.

---

# P10 — Bot difficulty and the mini-tutorial

Covers **F1, F10**.

## The session

- F1 — bot difficulty should be selectable.
- F10 — a short brief per mode: what the objective is, where to take the bomb.

## F1 — the system exists; what is missing is the selector

`src/shared/ai/DifficultyTiers.ts` already defines four tiers varying reaction time, accuracy
cone, convergence rate and push aggression, and `src/shared/ai/BotArsenal.ts` treats the weapon
as a difficulty lever in its own right. So this is **not** a session that builds a difficulty
system — it is a session that exposes one:

- a selection in the menu for solo and local play;
- an environment variable in `src/server/Config.ts` for the server, with `deploy/operator.env`
  and `DEPLOY.md` updated;
- the choice reaching `BotDirector` through one path. If there is a hard-coded value today that
  bypasses the table, deleting it is the work.

Do not scatter new numbers. If a tier is mistuned, it is tuned in that table, in one place.

## F10 — the brief belongs to the mode, not to the HUD

The temptation is a map of strings in the UI. The right shape: **every mode declares its own
brief** on the `src/shared/modes/GameMode.ts` interface, and the HUD draws whatever the mode
says. That way a new mode cannot forget one, and it can be checked headlessly that every
registered mode has a brief — another check in this project's style: a class of bug turned into a
check that fails.

Presentation: the banner that already exists (`HudBanner.ts:126` / `HudStreaks.ts:139`), in the
warmup window that round 2 already lengthened to 10 seconds. Note that the same window already
shows the quick class selector and sometimes the ballot — define the priority between those
surfaces and do not draw one over another (see P1).

## Verification

- Headless: every registered mode returns a non-empty brief; a match at each difficulty tier with
  the same seed, printing bot K/D per tier. If the tiers do not produce different numbers, the
  selector is not wired.
- Needs a browser: the text is readable and does not collide with the class selector.

---

# P11 — Planning brief: the large content

Covers **F4, F5, F6, F16, F17**. **This session writes no product code.**

## The session

Five items from the report are a milestone rather than a bug:

- F4 — character skins and 3D models.
- F5 — a story.
- F6 — more maps.
- F16 — new killstreaks: minigun, flamethrower, riot shield with pistol.
- F17 — a detailed grenade-throw animation (hand movement, pulling the pin).

**Write no product code in this session.** The deliverable is a milestone brief in `PLAN.md`, in
the format of the other briefs there, and it must bring the decisions to the human rather than
take them on their behalf.

## The constraint that decides nearly everything — open with it

This project has **no asset files at all**: no png, no glb, no wav. Everything is procedural —
`ProceduralTextures`, `ProceduralAudio`, `CamoTextures`, `WeaponMeshParts`, `KnifeMesh`,
`BotMesh`, `StreakMeshes`. That is an architectural decision with teeth: no asset pipeline, no
download budget, no CDN, and the whole build is code.

"Skins and 3D models" (F4) is therefore a fork in the road, not a feature:

(a) stay procedural — skins as parameters, the way `CamoTextures` works today. Cheap, consistent,
    low ceiling.
(b) build an asset pipeline — glTF, loading, caching, versioning, download size, licensing. That
    is a milestone in itself and it changes the game's startup profile.

Present both with cost, risk and the effect on load time, and recommend one. Start neither.

## What to do for each item

- **F16** — for each new streak: what it costs in the currency P4 introduced, who simulates it
  (the server), what crosses the wire, what happens when its owner disconnects (there is a
  precedent: S8.23 case 4, the chopper that comes down with its owner), and what it looks like
  without assets. The riot shield changes the hitbox model — that is the heaviest of the three,
  say so.
- **F17** — a cosmetic animation that must pass `check:cosmetics`: it does not touch the throw
  timing the simulation knows about (`ThrowController`). Define where the line runs between what
  is seen and what is counted.
- **F6** — what a new map costs: geometry, the navmesh (`NavBake`), spawn points, objective zones
  per mode, client background build time (§8.7), and the vote ballot.
- **F5** — a story in an arena game: say honestly what it could be (a frame, a campaign, bots with
  an order of battle) and what each costs. Do not assume the answer is a campaign.

## The deliverable

A "Milestone 12 — proposed" section in `PLAN.md`: scope, dependency order, what each item breaks,
and the list of decisions waiting on the human, each with a recommendation. One commit that adds
documentation only.

---

## הערה על השימוש

כל סשן הוא סשן טרייה, ואחת בכל פעם. ההעברה היחידה בין סשנים היא `PLAN.md` (והקובץ הזה) —
שתי מילסטונות באותו הקשר גורמות לשנייה לרשת את ההנחות של הראשונה בלי לבדוק אותן.

לפני סגירת כל סשן: ודא שנוצר קטע ב-`PLAN.md` ושיש commit. אם לא — הסשן הבאה מתחילה עיוורת.
