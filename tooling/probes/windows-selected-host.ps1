param([Parameter(Mandatory = $true)][int]$ObservedPid)
$ErrorActionPreference = 'Stop'
$processRows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId -ErrorAction Stop)
[pscustomobject]@{
  schema = 'amabie-windows-selected-host/1'
  edition = $PSVersionTable.PSEdition
  major = $PSVersionTable.PSVersion.Major
  version = $PSVersionTable.PSVersion.ToString()
  count = $processRows.Count
  observedPid = $ObservedPid
  selfObserved = [bool]($processRows | Where-Object { $_.ProcessId -eq $ObservedPid })
} | ConvertTo-Json -Compress
