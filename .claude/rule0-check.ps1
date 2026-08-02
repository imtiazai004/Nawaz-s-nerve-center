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

    $candidates = @(
        Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FullName -ne $ref -and
                $_.FullName -ne $log -and
                $_.FullName -notlike '*\.claude\*' -and
                $_.FullName -notlike '*\node_modules\*' -and
                $_.FullName -notlike '*\.git\*' -and
                $_.LastWriteTime -gt $baseline
            }
    )

    # Drop anything git ignores — build output above all.
    #
    # This fired for real: `npm run check` rebuilds web/dist as its last act, so a session
    # that ended with the test suite always looked like it had touched five undocumented
    # files after writing the reference. Rule 0 asks whether the *record* was brought
    # current, and a regenerated artifact is not a change to the record — the source it was
    # built from is, and that source trips this check on its own.
    #
    # Worth being blunt about why this matters more than the false positive costs: a check
    # that cries wolf every session teaches everyone to dismiss it, and then it is not
    # enforcing the rule it exists for. Same reasoning as the baseline fix above.
    #
    # Fails open in both directions: no git, no repo, or an unreadable list leaves the
    # candidates untouched and the check simply behaves as it did before.
    if ($candidates.Count -gt 0) {
        try {
            $ignored = ($candidates.FullName | & git -C $root check-ignore --stdin 2>$null)
            if ($ignored) {
                # git C-quotes any path needing it, and every path here does: the project
                # root contains spaces. So `D:\a b\x.js` comes back as `"D:\\a b\\x.js"`,
                # quotes and all, and comparing that to a FullName matches nothing — which
                # is exactly how the first version of this filter silently did nothing.
                # `-z` would avoid the quoting but expects NUL-separated input too, which
                # collapses a multi-line stdin into one bogus path. Unquoting is the
                # predictable option.
                $clean = @($ignored | ForEach-Object {
                    $s = $_.Trim()
                    if ($s.Length -ge 2 -and $s.StartsWith('"') -and $s.EndsWith('"')) {
                        # Strip the quotes, then undo the doubling of separators.
                        $s = $s.Substring(1, $s.Length - 2).Replace('\\', '\')
                    }
                    # PowerShell terminates each piped line with CRLF; git strips the LF and
                    # keeps the CR as part of the pathname, then escapes it back out as a
                    # literal `\r`. Left in place it defeats the comparison entirely — which
                    # is the second way this filter managed to silently do nothing.
                    $s = $s -replace '\\r$', ''
                    $s.TrimEnd([char]13, [char]10).Replace('/', '\')
                })

                $skip = [System.Collections.Generic.HashSet[string]]::new(
                    [string[]]$clean,
                    [StringComparer]::OrdinalIgnoreCase
                )
                $candidates = @($candidates | Where-Object { -not $skip.Contains($_.FullName) })
            }
        }
        catch { }
    }

    # Truncate after filtering, never before: eight ignored artifacts would otherwise crowd
    # out the one real file the message needed to name.
    $changed = @($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 8)

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
