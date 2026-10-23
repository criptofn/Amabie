param([Parameter(Mandatory = $true)][int]$ObservedPid)
$ErrorActionPreference = 'Stop'
$processRows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop)
$selfRows = @($processRows | Where-Object { $_.ProcessId -eq $ObservedPid })
if ($selfRows.Count -ne 1 -or $null -eq $selfRows[0].CreationDate) {
  throw 'CIM must return exactly one live parent identity with CreationDate'
}
[pscustomobject]@{
  schema = 'amabie-windows-selected-host/1'
  edition = $PSVersionTable.PSEdition
  major = $PSVersionTable.PSVersion.Major
  version = $PSVersionTable.PSVersion.ToString()
  count = $processRows.Count
  observedPid = $ObservedPid
  selfObserved = $true
  observedParentPid = $selfRows[0].ParentProcessId
  observedCreatedAt = $selfRows[0].CreationDate.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress
