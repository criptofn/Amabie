param([Parameter(Mandatory=$true)][uint32]$TaskRootPid)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AmabieRootHandleProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr process);
}
'@
$taskHandle=[AmabieRootHandleProbe]::OpenProcess(0x101000,$false,$TaskRootPid)
if($taskHandle -eq [IntPtr]::Zero) {
  @{opened=$false;error=[Runtime.InteropServices.Marshal]::GetLastWin32Error();requested=$TaskRootPid} | ConvertTo-Json -Compress
  exit 0
}
try {
  [uint32]$taskExit=0
  if(-not [AmabieRootHandleProbe]::GetExitCodeProcess($taskHandle,[ref]$taskExit)){throw 'GetExitCodeProcess failed'}
  @{opened=$true;requested=$TaskRootPid;actual=[AmabieRootHandleProbe]::GetProcessId($taskHandle);wait=[AmabieRootHandleProbe]::WaitForSingleObject($taskHandle,0);exitCode=$taskExit} | ConvertTo-Json -Compress
} finally {
  [void][AmabieRootHandleProbe]::CloseHandle($taskHandle)
}
