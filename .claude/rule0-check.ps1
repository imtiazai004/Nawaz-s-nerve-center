# Rule 0 enforcement — District Nerve Center
#
# Stop hook. Fires when Claude finishes a turn. If anything under
# "Build with Claude" was modified more recently than CLAUDE.md or CHANGELOG.md,
# it blocks the stop once and tells Claude to bring the reference up to date.
#
# Fails open: any error here exits 0 so a broken hook can never wedge a session.

$ErrorActionPreference = 'Stop'

try {
    $raw = [Console]::In.ReadToEnd()
    $sid = 'nosession'
    if ($raw) {
        try { $v = (ConvertFrom-Json $raw).session_id; if ($v) { $sid = $v } } catch { }
    }

    # .../Build with Claude/.claude/rule0-check.ps1  ->  .../Build with Claude
    $root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
    $ref  = Join-Path $root 'CLAUDE.md'
    $log  = Join-Path $root 'CHANGELOG.md'

    if (-not (Test-Path -LiteralPath $ref)) { exit 0 }

    # Nudge at most once per session — never loop.
    $mark = Join-Path $env:TEMP ("dnc-rule0-" + ($sid -replace '[^A-Za-z0-9\-]', '') + ".flag")
    if (Test-Path -LiteralPath $mark) { exit 0 }

    $refTime = (Get-Item -LiteralPath $ref).LastWriteTime
    $logTime = if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).LastWriteTime }
               else { [datetime]::MinValue }

    # Compare against the LATER of the two reference files.
    #
    # An earlier version used the earlier one, reasoning that both must be current. That
    # was wrong, and it produced a false positive the first time it mattered: updating
    # CLAUDE.md, then backlog/todos.md, then CHANGELOG.md is a perfectly correct sequence,
    # but the older reference timestamp made todos.md look unattended.
    #
    # Rule 0 is not an ordering constraint. It asks whether the reference was brought
    # current before finishing, and a later write to either file is evidence that it was.
    #
    # Known limitation, accepted: updating only CHANGELOG.md and forgetting CLAUDE.md will
    # not be caught. A hook that cries wolf gets ignored, which costs more than that miss.
    $baseline = if ($refTime -gt $logTime) { $refTime } else { $logTime }

    $changed = @(
        Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FullName -ne $ref -and
                $_.FullName -ne $log -and
                $_.FullName -notlike '*\.claude\*' -and
                $_.FullName -notlike '*\node_modules\*' -and
                $_.FullName -notlike '*\.git\*' -and
                $_.LastWriteTime -gt $baseline
            } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 8
    )

    if ($changed.Count -eq 0) { exit 0 }

    New-Item -ItemType File -Path $mark -Force | Out-Null

    $names = ($changed | ForEach-Object {
        $_.FullName.Substring($root.Length).TrimStart('\')
    }) -join ', '

    $reason = @"
Rule 0 (CLAUDE.md) has not been satisfied. These files changed after CLAUDE.md / CHANGELOG.md were last written: $names

Before finishing:
1. Update CLAUDE.md - section 5 (Current state) and section 6 (Repository map) at minimum, plus section 3 or 4 if a decision or invariant changed.
2. Append ONE entry to CHANGELOG.md (append only - never edit a past entry) using the Added / Changed / Removed / Decided / Open format.
3. If nothing substantive changed (a typo fix, a reformat), do not write a hollow changelog entry - say so plainly in your summary instead.

This reminder fires once per session.
"@

    $payload = @{ decision = 'block'; reason = $reason } | ConvertTo-Json -Compress
    Write-Output $payload
    exit 0
}
catch {
    exit 0
}
