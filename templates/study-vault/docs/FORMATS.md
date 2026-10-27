# Vault file formats

The hub indexes these files into `study.db` whenever they change. A file that does not parse is
skipped and listed by `study status` (with the reason), so a typo never breaks the rest of the vault.
All paths below are inside `semesters/<semester>/subjects/<subject>/` unless they start with `/`.
Ids are lowercase `a-z 0-9 -`, prefixed with the subject id (`lana-eigen`, `fsp-bayes`).

## `syllabus.md` — the skeleton (one per subject)

```markdown
## Week 3: Eigenvalues
- Eigenvalues and eigenvectors
- Diagonalisation {#lana-diag}      fixed id (optional)
- Power iteration (weight 2)        exam weight (optional, default 1)
```

Every list item becomes a concept stub (`status: stub`) the first time it is seen. Stubs exist before
IITJ releases the week; ingestion fills them in.

## `concepts/<id>.md` — one card per concept

```markdown
---
id: lana-eigen
title: Eigenvalues and eigenvectors
week: 3
order: 12            # position in the syllabus (stubs get it automatically)
status: ready        # stub | ready
released: true       # covered by an IITJ asset released so far
examWeight: 2
minutes: 30          # learning time, 20–40
prereqs: [lana-matrix-mult]
confusedWith: [lana-svd]
testedBy: [lana-pyq-2024-3]
graded: lana-a2      # part of a live graded assignment → hints only until it is submitted
formulas:
  - { id: char-eq, latex: '\det(A - \lambda I) = 0', name: Characteristic equation }
sources:
  - { asset: lana-w3-slides, ref: "slides 4–9" }
notation:
  - { iitj: '\lambda_i', resource: '\lambda', meaning: i-th eigenvalue }
---
## Definition
…one idea, testable by one question…
```

Duplicates: keep one card and give the other `mergedInto: <kept-id>` (never delete a card that has evidence).

## `paths/<concept-id>.yaml` — where to learn it

```yaml
concept: lana-eigen
segments:                       # 1–3: intuition → formal → worked example
  - kind: intuition             # intuition | formal | example
    url: https://www.youtube.com/watch?v=PFDu9oVAE-g
    start: "0:00"               # seconds or m:ss / h:mm:ss (videos)
    end: "17:15"
    pages: ''                   # "112-118" for books / notes instead of times
    source: 3Blue1Brown
    university: ''              # MIT, Harvard, Stanford, Brown … (portfolio)
    course: Essence of Linear Algebra
    lecture: Chapter 14
    why: Best visual intuition; same λ notation as the slides.
    checkedAt: "2026-10-28"     # the link was fetched and verified that day
alternates: []                  # shown after a missed check (same fields)
```

## `packs/<concept-id>.yaml` — the check pack (what "correct" looks like)

```yaml
concept: lana-eigen
keyPoints:                      # 5–8; the explanation must contain ≥ 80 %
  - { id: k1, text: An eigenvector keeps its direction under A, keywords: [direction, span, same line] }
misconceptions:
  - { id: m1, text: Every matrix has real eigenvalues }
questions:                      # 5–10
  - id: q1
    kind: numeric               # short | numeric | mcq
    q: Eigenvalues of [[2,0],[0,3]]? Give the larger one.
    answer: "3"
    tolerance: 0
  - id: q2
    kind: mcq
    q: Which vector is an eigenvector of [[1,1],[0,1]]?
    options: ["(1,0)", "(0,1)", "(1,1)"]
    answer: "(1,0)"
  - id: q3
    kind: short
    q: Why does det(A − λI) = 0 give the eigenvalues?
    answer: A − λI must be singular so that a non-zero v exists with (A − λI)v = 0.
    keywords: [singular, non-zero, null space]
    rubric: Must say A − λI is singular / has a non-trivial null space.
formulas: ['\det(A - \lambda I) = 0']
hints: ['Look for vectors that stay on their own line.', 'Write (A − λI)v = 0 and ask when v ≠ 0 is possible.']
```

The Quick Tutor may only compare against this file. It can never add questions or key points.

## `labs/<lab-id>/lab.yaml` — implement it (hidden tests run on this PC)

```yaml
id: lana-eigen-lab
concept: lana-eigen
title: Power iteration
entry: power_iteration          # the function the hidden tests call
timeoutSec: 20
task: |
  Implement power_iteration(A, iters) returning the dominant eigenvalue.
starter: |
  def power_iteration(A, iters=100):
      ...
hiddenTests: hidden_test.py     # in this folder; never shown before the run
```

`hidden_test.py` defines `test_*` functions. `entry` (the submitted function) and `solution`
(the submitted module) are available as globals:

```python
def test_diagonal():
    assert abs(entry([[2, 0], [0, 1]]) - 2) < 1e-6
```

## `questions/*.yaml` — the question bank

```yaml
questions:
  - id: lana-pyq-2024-3
    concepts: [lana-eigen]
    source: pyq                 # pyq | official | external | generated
    style: iitj                 # in the style of IITJ quizzes / assignments (optional)
    kind: numerical             # conceptual | numerical | derivation | mcq | programming
    q: Find the eigenvalues of …
    answer: λ = 1, 4
    marks: 4
    rubric:
      - { point: Characteristic polynomial correct, marks: 2 }
      - { point: Both roots, marks: 2 }
    transfer: false
    # programming only:
    entry: solve
    starter: "def solve(...):\n    ..."
    tests: questions/hidden/lana-pyq-2024-3_test.py
```

## `/tests/<YYYY-MM-DD>/paper.yaml` — a 3-day test (built by `/build-test`)

```yaml
id: "2026-10-31"
title: 3-day test 1
createdAt: "2026-10-31"
durationMin: 75
released: true
items:
  - id: lana-1
    subject: lana
    concepts: [lana-eigen]
    bucket: new                 # new (40%) | retention (25%) | mistake (20%) | transfer (15%)
    style: iitj
    kind: numerical
    q: …
    marks: 4
    rubric: [{ point: …, marks: 2 }]   # fixed before release
    answer: …                   # never shown before grading
  - id: lana-p1
    subject: lana
    concepts: [lana-eigen]
    bucket: transfer
    kind: programming
    q: Implement …
    entry: solve
    starter: "def solve(A):\n    ..."
    tests: hidden/lana-p1_test.py      # relative to this test folder
    marks: 6
```

## `/tests/<YYYY-MM-DD>/grading.yaml` — written by `/grade`

```yaml
test: "2026-10-31"
items:
  - id: lana-1
    marks: 3
    feedback: Characteristic polynomial right, one root wrong.
    mistakes: [{ concept: lana-eigen, cls: calculation, detail: root of quadratic }]
reviewNotes:
  lana-p1: Correct; vectorise the loop.
```

Mistake classes: `concept_gap`, `formula_recall`, `wrong_method`, `calculation`, `notation`,
`misread`, `incomplete`, `confusion`. Then run `study test finalize <date>`.
