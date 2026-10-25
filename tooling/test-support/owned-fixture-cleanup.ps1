param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][ValidatePattern('^amabie-test-owner:[a-f0-9-]{36}$')][string]$OwnerToken,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable
)
$ErrorActionPreference = 'Stop'
function Invoke-OwnedFixtureCleanup {
    try { $ownedProcess = [Diagnostics.Process]::GetProcessById($TargetProcessId) }
    catch [ArgumentException] { return @{ processId = $TargetProcessId; outcome = 'absent' } }
    try {
        # Opening and retaining the handle pins kernel identity while CIM runs.
        $null = $ownedProcess.Handle
        if ($ownedProcess.HasExited) { return @{ processId = $TargetProcessId; outcome = 'absent' } }
        $createdTicks = $ownedProcess.StartTime.ToUniversalTime().Ticks
        $row = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$TargetProcessId" -Property ProcessId,CreationDate,CommandLine -ErrorAction Stop
        if ($null -eq $row -or $ownedProcess.HasExited) { return @{ processId = $TargetProcessId; outcome = 'absent' } }
        if ($null -eq $row.CreationDate) { throw 'Fixture creation identity unavailable' }
        # CIM has microsecond precision; the kernel time includes 100ns ticks.
        $observedTicks = $row.CreationDate.ToUniversalTime().Ticks
        if (($createdTicks - ($createdTicks % 10)) -ne ($observedTicks - ($observedTicks % 10))) {
            return @{ processId = $TargetProcessId; outcome = 'not-owned' }
        }
        $marker = '(^|[\s"])' + [regex]::Escape($OwnerToken) + '($|[\s"])'
        if (-not [string]::Equals($ownedProcess.MainModule.FileName, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
            $row.CommandLine -notmatch $marker) {
            return @{ processId = $TargetProcessId; outcome = 'not-owned' }
        }
        # Kill through the retained handle, never taskkill on a stale numeric PID.
        $ownedProcess.Kill()
        return @{ processId = $TargetProcessId; outcome = 'terminated' }
    } finally { $ownedProcess.Dispose() }
}
Invoke-OwnedFixtureCleanup | ConvertTo-Json -Compress
