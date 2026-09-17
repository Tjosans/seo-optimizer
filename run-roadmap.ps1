<#
=============================================================================
Roadmap Execution Loop for Claude Code  (v2)
=============================================================================
Purpose:
  Iteratively reads roadmap.md, executes the next unchecked task in a FRESH
  Claude Code session (fresh context every time), runs tests, and creates one
  isolated git commit per task.

Usage:
  .\run-roadmap.ps1
  .\run-roadmap.ps1 -Model opus -Effort high -TestCommand "npm test"
=============================================================================
#>

param(
    [string]$RoadmapFile   = "roadmap.md",
    [int]   $MaxIterations = 20,
    [string]$Model         = "sonnet",     # sonnet | opus | fable | claude-sonnet-5 ...
    [string]$Effort        = "high",       # low | medium | high | xhigh | max
    [string]$TestCommand   = "npm test",   # the exact command Claude must run
    [int]   $MaxTurns      = 80            # safety cap per task (agent turns)
)

$LogDir = "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- Pre-flight checks -------------------------------------------------------
if (-not (Test-Path $RoadmapFile)) {
    Write-Error "Could not find $RoadmapFile."; exit 1
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

Write-Host "Starting autonomous roadmap runner (model=$Model, effort=$Effort)..." -ForegroundColor Cyan

$Pattern     = '^\s*- \[ \] (.+?)\s*$'
$Iteration   = 0
$LastTask    = $null
$RepeatCount = 0

while ($Iteration -lt $MaxIterations) {
    $Iteration++

    # ---- Pick the first unchecked task ------------------------------------
    $Content = Get-Content $RoadmapFile -Raw
    $Match   = [regex]::Match($Content, $Pattern, 'Multiline')
    if (-not $Match.Success) {
        Write-Host "All roadmap tasks are complete!" -ForegroundColor Green
        break
    }
    $Task = $Match.Groups[1].Value.Trim()

    # ---- Stuck detection: same task seen 3 times = 2 failed attempts -------
    if ($Task -eq $LastTask) { $RepeatCount++ } else { $RepeatCount = 0 }
    if ($RepeatCount -ge 2) {
        $Content = $Content.Replace("- [ ] $Task", "- [!] $Task  <!-- BLOCKED by runner after 2 attempts -->")
        Set-Content -Path $RoadmapFile -Value $Content -NoNewline
        git add -- $RoadmapFile
        git commit -m "chore(roadmap): mark task as blocked" -m $Task | Out-Null
        Write-Warning "Task was not completed after 2 attempts. Marked [!] and stopping: $Task"
        break
    }
    $LastTask = $Task

    Write-Host "`n==================================================" -ForegroundColor Yellow
    Write-Host "Iteration $Iteration : $Task" -ForegroundColor Yellow
    Write-Host "==================================================" -ForegroundColor Yellow

    # ---- Prompt: one self-contained task, explicit rules -------------------
    $Prompt = @"
You are an automated software engineer working in a fresh session with no memory of earlier runs.
Read CLAUDE.md first for conventions, architecture and the progress log.

Your ONE task for this session (copied from $RoadmapFile):
"$Task"

Rules:
1. Implement ONLY this task, cleanly and modularly. Do not start any other roadmap item.
2. Run the test suite with exactly: $TestCommand
3. If tests pass: in $RoadmapFile change the line '- [ ] $Task' to '- [x] $Task'.
   If tests still fail after reasonable attempts: do NOT mark it done. Add an indented line
   directly under the task starting with '  - NOTE:' explaining what is blocking it.
4. Append one line under the '## Progress log' heading in CLAUDE.md:
   '- $Task — <one short sentence on what changed>'
5. Do NOT run git commit or git push. The runner script commits after you finish.
End with a one-line summary of what you did.
"@

    # ---- Run Claude Code headless, capture structured output ---------------
    $LogFile = Join-Path $LogDir ("iter-{0:D2}.json" -f $Iteration)
    claude -p $Prompt `
        --permission-mode auto `
        --model $Model `
        --effort $Effort `
        --max-turns $MaxTurns `
        --output-format json | Set-Content -Path $LogFile -Encoding utf8
    $ExitCode = $LASTEXITCODE

    $Result = $null
    try { $Result = Get-Content $LogFile -Raw | ConvertFrom-Json } catch { }

    if ($ExitCode -ne 0 -or ($Result -and $Result.is_error)) {
        Write-Error "Claude Code failed on iteration $Iteration (exit $ExitCode). See $LogFile"
        break
    }
    if ($Result -and $Result.result) {
        Write-Host $Result.result -ForegroundColor Gray
    }

    # ---- Commit only if something actually changed -------------------------
    if (-not (git status --porcelain)) {
        Write-Warning "No file changes produced for this task. Retrying once."
        continue
    }
    $Short = if ($Task.Length -gt 60) { $Task.Substring(0, 60) + "..." } else { $Task }
    git add -A
    git commit -m "feat(roadmap): $Short" -m "Roadmap iteration $Iteration (model=$Model, effort=$Effort)" | Out-Null
    Write-Host "Iteration $Iteration committed." -ForegroundColor Green
}

Write-Host "`nRunner finished after $Iteration iteration(s). Logs in .\$LogDir" -ForegroundColor Cyan
