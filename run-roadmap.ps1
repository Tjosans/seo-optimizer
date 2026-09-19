<#
=============================================================================
Roadmap Execution Loop for Claude Code  (v3)
=============================================================================
Purpose:
  Iteratively reads ROADMAP.md, executes the next unchecked task in a FRESH
  Claude Code session (fresh context every time), runs tests, and creates one
  isolated git commit per task.

  A task that is still not done after -MaxAttempts is marked [!] and skipped,
  so one hard task does not stop the run; -MaxBlockedInARow tasks marked [!]
  in a row does, because that points at the build or the login, not the task.

  Every iteration ends with a clean working tree, whatever happened:
    - task done, tests green          -> feat commit
    - session ran out of turns/budget -> a short wrap-up session resumes it to
                                         get the tests green and leave a NOTE,
                                         then the runner verifies:
        tests green                   -> wip commit, the next attempt continues
        tests red                     -> the attempt is stashed (never deleted)
                                         and a NOTE naming the stash is committed
    - runner interrupted (Ctrl+C)     -> the attempt is stashed

Usage:
  .\run-roadmap.ps1
  .\run-roadmap.ps1 -Model opus -Effort high -TestCommand "npm test"
  .\run-roadmap.ps1 -MaxTurns 100 -WrapUpTurns 25 -MaxBudgetUsd 5
=============================================================================
#>

param(
    [string]$RoadmapFile   = "ROADMAP.md",
    [int]   $MaxIterations = 20,
    [string]$Model         = "sonnet",     # sonnet | opus | fable | claude-sonnet-5 ...
    [string]$Effort        = "high",       # low | medium | high | xhigh | max
    [string]$TestCommand   = "npm test",   # the exact command Claude must run
    [int]   $MaxTurns      = 80,           # safety cap per task (agent turns)
    [int]   $WrapUpTurns   = 20,           # extra turns to finish cleanly after the cap is hit
    [int]   $WrapUpReserve = 15,           # turns Claude is told to keep back for finishing
    [double]$MaxBudgetUsd  = 0,            # per-session spend cap; 0 = none
    [int]   $MaxAttempts   = 3,            # attempts per task before it is marked [!] and skipped
    [int]   $MaxBlockedInARow = 2,         # stop when this many tasks in a row are marked [!]
    [int]   $MaxTaskLength = 600,          # chars; a longer line is a batch, not a task
    [switch]$NoTestVerify                  # skip the runner's own test run before committing
)

$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogDir   = Join-Path "logs" $RunStamp
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- Pre-flight checks -------------------------------------------------------
# Resolve the roadmap by name, then by a case-insensitive match. Windows does
# not care which spelling the default uses; a case-sensitive filesystem does,
# and projects spell it both ROADMAP.md and roadmap.md.
if (-not (Test-Path -LiteralPath $RoadmapFile)) {
    $Leaf      = Split-Path -Leaf $RoadmapFile
    $Dir       = Split-Path -Parent $RoadmapFile
    if (-not $Dir) { $Dir = "." }
    $Candidate = Get-ChildItem -LiteralPath $Dir -File -Force |
                 Where-Object { $_.Name -ieq $Leaf } |
                 Select-Object -First 1
    if (-not $Candidate) {
        Write-Error "Could not find $RoadmapFile (no case-insensitive match either)."; exit 1
    }
    $RoadmapFile = $Candidate.FullName
    Write-Host "Using $($Candidate.Name) for $Leaf." -ForegroundColor DarkGray
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Error "The 'claude' CLI is not on PATH. Install Claude Code or run 'claude update'."; exit 1
}
git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "This folder is not a git repository."; exit 1
}
if (git status --porcelain) {
    Write-Error "Working tree is not clean. Commit or stash first so each task gets its own commit."; exit 1
}

# ---- Helpers -----------------------------------------------------------------

function Test-TreeDirty { [bool](git status --porcelain) }

function Get-Short([string]$Text) {
    if ($Text.Length -gt 60) { $Text.Substring(0, 60) + "..." } else { $Text }
}

# One headless Claude session. Returns the parsed JSON result (or $null) and
# the exit code; the raw JSON is kept in $LogFile either way.
function Invoke-ClaudeSession([string]$Prompt, [string]$LogFile, [int]$Turns, [string]$ResumeId) {
    $CliArgs = @('-p', $Prompt,
              '--permission-mode', 'auto',
              '--model', $Model,
              '--effort', $Effort,
              '--max-turns', $Turns,
              '--output-format', 'json')
    if ($ResumeId)         { $CliArgs += @('--resume', $ResumeId) }
    if ($MaxBudgetUsd -gt 0) { $CliArgs += @('--max-budget-usd', $MaxBudgetUsd) }
    claude @CliArgs | Set-Content -Path $LogFile -Encoding utf8
    $Code   = $LASTEXITCODE
    $Parsed = $null
    try { $Parsed = Get-Content $LogFile -Raw | ConvertFrom-Json } catch { }
    [pscustomobject]@{ Result = $Parsed; ExitCode = $Code }
}

# The runner's own check, so a commit never rests on the session's word alone.
function Test-Suite([string]$LogFile) {
    if ($NoTestVerify) { return $true }
    Write-Host "Verifying: $TestCommand" -ForegroundColor DarkGray
    Invoke-Expression "$TestCommand *>&1" | Out-File -FilePath $LogFile -Encoding utf8
    return ($LASTEXITCODE -eq 0)
}

function Test-TaskTicked([string]$Task) {
    (Get-Content $RoadmapFile -Raw).Contains("- [x] $Task")
}

# Put one indented NOTE line directly under the task's checkbox line.
function Add-TaskNote([string]$Task, [string]$Note) {
    $Content = Get-Content $RoadmapFile -Raw
    $Line    = "- [ ] $Task"
    $At      = $Content.IndexOf($Line)
    if ($At -lt 0) { return }
    $End     = $At + $Line.Length
    $Content = $Content.Substring(0, $End) + "`n  - NOTE: $Note" + $Content.Substring($End)
    Set-Content -Path $RoadmapFile -Value $Content -NoNewline
}

# Leave the tree clean, keeping whatever is worth keeping. Returns a word for
# what it did: committed | wip | stashed | clean.
function Complete-Iteration([string]$Task, [int]$Iteration, [string]$Why) {
    if (-not (Test-TreeDirty)) { return 'clean' }
    $Short = Get-Short $Task

    if (Test-Suite (Join-Path $LogDir ("iter-{0:D2}-tests.log" -f $Iteration))) {
        if (Test-TaskTicked $Task) {
            git add -A
            git commit -m "feat(roadmap): $Short" -m "Roadmap iteration $Iteration (model=$Model, effort=$Effort)" | Out-Null
            return 'committed'
        }
        # Partial but green: keep it, so the next attempt continues from it.
        $Content = Get-Content $RoadmapFile -Raw
        $Pos     = $Content.IndexOf("- [ ] $Task")
        $HasNote = $Pos -ge 0 -and $Content.Substring($Pos + $Task.Length + 6).TrimStart("`r", "`n").StartsWith("  - NOTE:")
        if (-not $HasNote) {
            Add-TaskNote $Task "iteration $Iteration ($Why) left partial work that passes the tests; the next attempt continues from it."
        }
        git add -A
        git commit -m "wip(roadmap): partial - $Short" -m "Roadmap iteration $Iteration stopped early ($Why); tests pass on what exists." | Out-Null
        return 'wip'
    }

    # Red: set the attempt aside rather than commit a broken tree or delete work.
    $Message = "roadmap-runner iteration $Iteration ($RunStamp): $Short"
    git stash push --include-untracked -m $Message | Out-Null
    Add-TaskNote $Task "iteration $Iteration ($Why) failed its tests and was stashed as '$Message' (see git stash list)."
    git add -- $RoadmapFile
    git commit -m "chore(roadmap): note stashed attempt" -m $Task | Out-Null
    return 'stashed'
}

Write-Host "Starting autonomous roadmap runner (model=$Model, effort=$Effort, logs=$LogDir)..." -ForegroundColor Cyan

$Pattern     = '^\s*- \[ \] (.+?)\s*$'
$Iteration   = 0
$LastTask    = $null
$Attempt     = 0
$Task        = $null
$BlockedRow  = 0

# Mark the current task [!] and decide whether the run can go on without it.
# A blocked task is skipped, not fatal: the pattern only matches '- [ ]', so
# the next iteration picks the task after it. Several in a row means the
# problem is not the task (a broken build, an expired login), so stop.
function Block-Task([string]$Task, [string]$Reason, [string]$Subject) {
    $Content = (Get-Content $RoadmapFile -Raw).Replace("- [ ] $Task", "- [!] $Task  <!-- $Reason -->")
    Set-Content -Path $RoadmapFile -Value $Content -NoNewline
    git add -- $RoadmapFile
    git commit -m $Subject -m $Task | Out-Null
    $script:BlockedRow++
    Write-Warning "Marked [!] and skipped ($Reason): $Task"
    return ($script:BlockedRow -lt $MaxBlockedInARow)
}

try {
    while ($Iteration -lt $MaxIterations) {
        $Iteration++

        # ---- Pick the first unchecked task --------------------------------
        $Content = Get-Content $RoadmapFile -Raw
        $Match   = [regex]::Match($Content, $Pattern, 'Multiline')
        if (-not $Match.Success) {
            Write-Host "All roadmap tasks are complete!" -ForegroundColor Green
            break
        }
        $Task = $Match.Groups[1].Value.Trim()

        # ---- Size guard: a task a fresh session cannot finish is not a task
        if ($Task.Length -gt $MaxTaskLength) {
            # No session is paid for, so this costs no iteration.
            $Iteration--
            $Go = Block-Task $Task "SPLIT by runner: $($Task.Length) chars is a batch, not a task. Break it into one checkbox per unit (e.g. one detector) and re-run." "chore(roadmap): mark oversized task for splitting"
            if ($Go) { continue } else { Write-Warning "$MaxBlockedInARow tasks in a row were marked [!]; stopping."; break }
        }

        # ---- Attempt limit -------------------------------------------------
        if ($Task -eq $LastTask) { $Attempt++ } else { $Attempt = 1 }
        if ($Attempt -gt $MaxAttempts) {
            $Iteration--
            $Go = Block-Task $Task "BLOCKED by runner after $MaxAttempts attempts" "chore(roadmap): mark task as blocked"
            if ($Go) { continue } else { Write-Warning "$MaxBlockedInARow tasks in a row were marked [!]; stopping."; break }
        }
        $LastTask = $Task

        Write-Host "`n==================================================" -ForegroundColor Yellow
        Write-Host "Iteration $Iteration (attempt $Attempt of $MaxAttempts) : $Task" -ForegroundColor Yellow
        Write-Host "==================================================" -ForegroundColor Yellow

        # ---- Prompt: one self-contained task, explicit rules ---------------
        $Prompt = @"
You are an automated software engineer working in a fresh session with no memory of earlier runs.
Read CLAUDE.md first for conventions and architecture, then ROADMAP.md.

Your ONE task for this session (copied from $RoadmapFile):
"$Task"

Rules:
1. Implement ONLY this task, cleanly and modularly. Do not start any other roadmap item.
   If '  - NOTE:' lines sit under the task, an earlier attempt left them: continue from that work.
2. Run the test suite with exactly: $TestCommand
3. If tests pass and the task is done: in $RoadmapFile change the line '- [ ] $Task' to '- [x] $Task'.
   If it is not done, or tests still fail after reasonable attempts: do NOT mark it done. Add an indented
   line directly under the task starting with '  - NOTE:' saying what is done and what remains.
4. If you made a non-obvious choice, add one dated line under '## Decisions' in $RoadmapFile
   ('- <YYYY-MM-DD>: <choice and one-line rationale>'). Do not edit CLAUDE.md unless the task says to.
5. Do NOT run git commit, git push or git stash. The runner script commits after you finish.
6. Budget: you have at most $MaxTurns turns. Keep the last $WrapUpReserve for finishing. Once you have
   used about $($MaxTurns - $WrapUpReserve), stop building: get the tests passing on what exists,
   then follow rule 3. Leaving the tests failing throws the whole attempt away.
End with a one-line summary of what you did.
"@

        $HeadBefore = git rev-parse HEAD
        $LogFile    = Join-Path $LogDir ("iter-{0:D2}.json" -f $Iteration)
        $Session    = Invoke-ClaudeSession $Prompt $LogFile $MaxTurns $null
        $Result     = $Session.Result
        $Why        = 'completed'

        # ---- Out of turns or budget: resume briefly to finish cleanly ------
        $Exhausted = $Result -and $Result.subtype -in @('error_max_turns', 'error_max_budget_usd')
        if ($Exhausted -and $Result.session_id) {
            $Why = $Result.subtype -replace '^error_', ''
            Write-Warning "Session hit its limit ($Why). Resuming for up to $WrapUpTurns turns to finish cleanly."
            $WrapUp = @"
You have run out of budget for this task. Do not start anything new. Use the next few turns only to:
1. Run: $TestCommand
2. If the task is complete and tests pass, tick it in $RoadmapFile ('- [ ] $Task' -> '- [x] $Task').
3. Otherwise, if tests pass with the partial work, keep it and add one line directly under the task:
   '  - NOTE: partial - <what is done; what remains>'.
4. If tests fail and a turn or two will not fix them, undo your own changes (git checkout -- <files>,
   delete files you created) and add the NOTE saying what you learned.
Do NOT commit, push or stash. End with a one-line summary.
"@
            $WrapLog = Join-Path $LogDir ("iter-{0:D2}-wrapup.json" -f $Iteration)
            $Wrapped = Invoke-ClaudeSession $WrapUp $WrapLog $WrapUpTurns $Result.session_id
            if ($Wrapped.Result -and $Wrapped.Result.result) { Write-Host $Wrapped.Result.result -ForegroundColor Gray }
        }
        elseif ($Session.ExitCode -ne 0 -or ($Result -and $Result.is_error)) {
            # Not a budget limit: auth, network or CLI failure. Keep what is
            # worth keeping, then stop rather than burn attempts on it.
            $Outcome = Complete-Iteration $Task $Iteration 'session error'
            Write-Error "Claude Code failed on iteration $Iteration (exit $($Session.ExitCode)); tree left $Outcome. See $LogFile"
            break
        }
        elseif ($Result -and $Result.result) {
            Write-Host $Result.result -ForegroundColor Gray
        }

        # ---- Leave the tree clean -------------------------------------------
        $Outcome = Complete-Iteration $Task $Iteration $Why
        $Moved   = (git rev-parse HEAD) -ne $HeadBefore
        switch ($Outcome) {
            'committed' { $BlockedRow = 0; Write-Host "Iteration $Iteration committed." -ForegroundColor Green }
            'wip'       { Write-Host "Iteration $Iteration committed partial work; the next attempt continues it." -ForegroundColor Yellow }
            'stashed'   { Write-Warning "Iteration $Iteration failed its tests; the attempt is in git stash and a NOTE was committed." }
            'clean'     {
                if ($Moved) {
                    # The session committed on its own despite rule 5. The work is in.
                    if (Test-TaskTicked $Task) { $BlockedRow = 0 }
                    Write-Host "Iteration $($Iteration): the session committed its own work." -ForegroundColor Green
                } else {
                    Write-Warning "No file changes produced for this task. Retrying."
                }
            }
        }
    }
}
finally {
    # Ctrl+C, or any error thrown above: never leave a half-edited tree behind.
    if (Test-TreeDirty) {
        $Message = "roadmap-runner interrupted ($RunStamp): $(if ($Task) { Get-Short $Task } else { 'no task' })"
        git stash push --include-untracked -m $Message | Out-Null
        Write-Warning "Runner stopped with uncommitted changes; they are stashed as '$Message' (git stash list)."
    }
}

Write-Host "`nRunner finished after $Iteration iteration(s). Logs in .\$LogDir" -ForegroundColor Cyan
