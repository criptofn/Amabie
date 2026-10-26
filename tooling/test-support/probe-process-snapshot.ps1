param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
# Diagnostic only: never terminate, wait for, or authorize a process by name.
$row = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$TargetProcessId" -Property ProcessId,ParentProcessId,CreationDate,Name -ErrorAction Stop
if ($null -eq $row) {
    [ordered]@{ processId = $TargetProcessId; present = $false } | ConvertTo-Json -Compress
} else {
    [ordered]@{
        processId = [int]$row.ProcessId
        present = $true
        parentProcessId = [int]$row.ParentProcessId
        name = [string]$row.Name
        createdAt = $(if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { $null })
    } | ConvertTo-Json -Compress
}
