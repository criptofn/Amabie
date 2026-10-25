/** Source-owned PowerShell bootstrap. No environment or project-controlled override. */
export const WINDOWS_PROCESS_IDENTITY_BOOTSTRAP = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace AmabieSweep {
  public sealed class NativeProcess : IDisposable {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
    IntPtr handle;
    public long CreationTicks { get; private set; }
    NativeProcess(IntPtr value) {
      handle = value;
      try {
        long created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        CreationTicks = DateTime.FromFileTimeUtc(created).Ticks;
      } catch { Dispose(); throw; }
    }
    static NativeProcess Open(uint pid, bool terminate) {
      IntPtr value = OpenProcess(0x101000u | (terminate ? 1u : 0u), false, pid);
      if (value == IntPtr.Zero) {
        int error = Marshal.GetLastWin32Error();
        if (error == 87) return null;
        throw new Win32Exception(error);
      }
      return new NativeProcess(value);
    }
    public static NativeProcess Root(uint pid) {
      NativeProcess process = Open(pid, false);
      if (process == null) throw new InvalidOperationException("retained root process identity unavailable");
      return process;
    }
    public static NativeProcess Child(uint pid, long expectedTicks, long parentTicks) {
      NativeProcess process = Open(pid, true);
      if (process == null) return null;
      // CIM represents microseconds; use integer arithmetic, not lossy doubles.
      long actual = process.CreationTicks;
      if (actual - actual % 10 != expectedTicks - expectedTicks % 10 || actual < parentTicks) {
        process.Dispose();
        return null;
      }
      return process;
    }
    public bool Terminate() {
      if (handle == IntPtr.Zero) throw new ObjectDisposedException("NativeProcess");
      uint wait = WaitForSingleObject(handle, 0);
      if (wait == 0) return false;
      if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (TerminateProcess(handle, 0xffffffffu)) return true;
      int error = Marshal.GetLastWin32Error();
      if (WaitForSingleObject(handle, 0) == 0) return false;
      throw new Win32Exception(error);
    }
    public void Dispose() {
      if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
  }
}
'@
function Open-SweepIdentity {
  param([int]$ProcessId,[long]$ExpectedTicks,[long]$ParentTicks,[switch]$Root)
  if($Root){[AmabieSweep.NativeProcess]::Root([uint32]$ProcessId)}
  else{[AmabieSweep.NativeProcess]::Child([uint32]$ProcessId,$ExpectedTicks,$ParentTicks)}
}
function Stop-ProcessIdentity { param([object]$Identity); $Identity.Terminate() }
`;
