param([string]$Pipe, [string]$Package, [string]$Ready, [switch]$DenyPackage)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../../../tools/windows-boundary/AmabieBroker.cs')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MediumPipeLabel {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr sd,out uint size);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorSacl(IntPtr sd,out bool present,out IntPtr acl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr h,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,uint revision,uint info,out IntPtr text,out uint size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  public static void Set(IntPtr handle) {
    IntPtr sd; uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;ME)",1,out sd,out size)) throw new Exception("SDDL failed");
    try {
      bool present,defaulted; IntPtr acl;
      if(!GetSecurityDescriptorSacl(sd,out present,out acl,out defaulted) || !present) throw new Exception("ACL missing");
      uint error=SetSecurityInfo(handle,6,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,acl);
      if(error!=0) throw new Exception("label error "+error);
    } finally { LocalFree(sd); }
  }
  public static string Dacl(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,descriptor,text; owner=group=dacl=sacl=descriptor=text=IntPtr.Zero; uint size;
    uint error=GetSecurityInfo(handle,6,0x4,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0) throw new Exception("DACL read failed "+error);
    try {
      if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor,1,0x4,out text,out size)) throw new Exception("DACL conversion failed "+Marshal.GetLastWin32Error());
      return Marshal.PtrToStringUni(text);
    } finally { if(text!=IntPtr.Zero) LocalFree(text); if(descriptor!=IntPtr.Zero) LocalFree(descriptor); }
  }
}
'@
$security = [System.IO.Pipes.PipeSecurity]::new()
$security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
  [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
if ($DenyPackage) {
  $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new($Package),
    [System.IO.Pipes.PipeAccessRights]::ReadWrite, [System.Security.AccessControl.AccessControlType]::Deny))
}
if (-not $DenyPackage) {
  $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new($Package),
    [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
}
# Intentionally wrong (medium) mandatory label, with the same package DACL.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $server = [System.IO.Pipes.NamedPipeServerStreamAcl]::Create($Pipe,
    [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security,
    [System.IO.HandleInheritability]::None, [System.IO.Pipes.PipeAccessRights]0)
} else {
  $server = [System.IO.Pipes.NamedPipeServerStream]::new($Pipe,
    [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security)
}
try {
  [MediumPipeLabel]::Set($server.SafePipeHandle.DangerousGetHandle())
  $rejected = $false
  try { [AmabieBroker.Broker]::VerifyLowMandatoryLabel($server.SafePipeHandle.DangerousGetHandle()) }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'negative pipe unexpectedly has a low label' }
  $dacl = [MediumPipeLabel]::Dacl($server.SafePipeHandle.DangerousGetHandle())
  [System.IO.File]::WriteAllText($Ready, (@{ mediumLabelInstalled=$true; lowReadbackRejected=$rejected; denyPackage=[bool]$DenyPackage; dacl=$dacl } | ConvertTo-Json -Compress))
  while ($true) {
    $server.WaitForConnection()
    $reader = [System.IO.StreamReader]::new($server)
    $null = $reader.ReadLine()
    $writer = [System.IO.StreamWriter]::new($server)
    $writer.AutoFlush = $true
    $writer.WriteLine('{"status":200}')
    $null = $reader.ReadLine()
    $server.Disconnect()
  }
} finally { $server.Dispose() }
