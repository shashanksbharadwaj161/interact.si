# Shared helpers for Jarvis native scripts. Original code. Windows PowerShell 5.1 compatible.
# Contract: JSON input on stdin (UTF-8), exactly one JSON result line on stdout. Never reads the command line.
$ErrorActionPreference = 'Stop'

function Read-JarvisInput {
    $stdin = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]@{} }
    return ($text | ConvertFrom-Json)
}

function Write-JarvisResult($obj) {
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json + "`n")
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

function Add-JarvisWin32 {
    if ('Jarvis.Win32' -as [type]) { return }
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace Jarvis {
  public class WinInfo {
    public long Hwnd { get; set; }
    public string Title { get; set; }
    public int Pid { get; set; }
    public string Process { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Minimized { get; set; }
    public bool Maximized { get; set; }
    public bool Foreground { get; set; }
    public int Elevated { get; set; }
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  public static class Win32 {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);

    public static void InitDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }

    public static bool Exists(long h) { return IsWindow(new IntPtr(h)); }
    public static int PidOf(long h) { uint p; GetWindowThreadProcessId(new IntPtr(h), out p); return (int)p; }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    public static int ForegroundPid() { return PidOf(GetForegroundWindow().ToInt64()); }

    /// 1 = elevated, 0 = not elevated, -1 = unknown (access denied, treat as protected)
    public static int Elevated(int pid) {
      IntPtr proc = OpenProcess(0x1000, false, (uint)pid);
      if (proc == IntPtr.Zero) return -1;
      try {
        IntPtr tok;
        if (!OpenProcessToken(proc, 0x8, out tok)) return -1;
        try { int e; int ret; if (!GetTokenInformation(tok, 20, out e, 4, out ret)) return -1; return e != 0 ? 1 : 0; }
        finally { CloseHandle(tok); }
      } finally { CloseHandle(proc); }
    }

    public static RECT Rect(long h) { RECT r; GetWindowRect(new IntPtr(h), out r); return r; }

    public static List<WinInfo> List() {
      List<WinInfo> res = new List<WinInfo>();
      IntPtr fg = GetForegroundWindow();
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        if (!IsWindowVisible(h)) return true;
        int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
        int len = GetWindowTextLengthW(h); if (len <= 0) return true;
        if ((GetWindowLongW(h, -20) & 0x80) != 0) return true; // WS_EX_TOOLWINDOW
        StringBuilder sb = new StringBuilder(len + 1); GetWindowTextW(h, sb, sb.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        WinInfo w = new WinInfo();
        w.Hwnd = h.ToInt64(); w.Title = sb.ToString(); w.Pid = (int)pid;
        try { w.Process = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName + ".exe"; } catch (Exception) { w.Process = ""; }
        w.X = r.Left; w.Y = r.Top; w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top;
        w.Minimized = IsIconic(h); w.Maximized = IsZoomed(h); w.Foreground = (h == fg);
        w.Elevated = Elevated((int)pid);
        res.Add(w);
        return true;
      }, IntPtr.Zero);
      return res;
    }

    public static bool Focus(long h) {
      IntPtr hw = new IntPtr(h);
      if (IsIconic(hw)) ShowWindow(hw, 9);
      SetForegroundWindow(hw);
      System.Threading.Thread.Sleep(80);
      if (GetForegroundWindow() == hw) return true;
      // Foreground lock workaround: a bare ALT tap lets the call through. No text is typed.
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hw);
      System.Threading.Thread.Sleep(120);
      return GetForegroundWindow() == hw;
    }

    /// Clamps to the virtual screen and moves. Returns true if the requested rect had to be adjusted.
    public static bool Move(long h, int x, int y, int w, int hgt, out RECT after) {
      IntPtr hw = new IntPtr(h);
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
      int nw = Math.Max(100, Math.Min(w, vw)), nh = Math.Max(60, Math.Min(hgt, vh));
      int nx = Math.Max(vx, Math.Min(x, vx + vw - nw)), ny = Math.Max(vy, Math.Min(y, vy + vh - nh));
      bool clamped = nw != w || nh != hgt || nx != x || ny != y;
      if (IsIconic(hw) || IsZoomed(hw)) ShowWindow(hw, 9);
      SetWindowPos(hw, IntPtr.Zero, nx, ny, nw, nh, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
      after = Rect(h);
      return clamped;
    }

    public static bool PointBelongsTo(int x, int y, int pid) {
      POINT p; p.X = x; p.Y = y;
      IntPtr top = GetAncestor(WindowFromPoint(p), 2);
      if (top == IntPtr.Zero) return false;
      return PidOf(top.ToInt64()) == pid;
    }

    public static void Click(int x, int y) {
      SetCursorPos(x, y);
      INPUT[] a = new INPUT[2];
      a[0].type = 0; a[0].u.mi.dwFlags = 0x0002;
      a[1].type = 0; a[1].u.mi.dwFlags = 0x0004;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Key(List<INPUT> l, ushort vk, ushort scan, uint flags) {
      INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; l.Add(i);
    }

    /// Types UTF-16 units via KEYEVENTF_UNICODE. Re-checks the foreground window every few characters.
    /// Returns the number of characters sent. Never uses SendKeys.
    public static int TypeText(long hwnd, int pid, string text) {
      int sent = 0; int i = 0;
      while (i < text.Length) {
        if (GetForegroundWindow().ToInt64() != hwnd || PidOf(hwnd) != pid) break;
        int end = Math.Min(text.Length, i + 16);
        if (end < text.Length && char.IsHighSurrogate(text[end - 1])) end--;
        List<INPUT> l = new List<INPUT>();
        for (; i < end; i++) {
          char c = text[i];
          if (c == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') continue; }
          if (c == '\n' || c == '\r') { Key(l, 0x0D, 0, 0); Key(l, 0x0D, 0, 2); }
          else if (c == '\t') { Key(l, 0x09, 0, 0); Key(l, 0x09, 0, 2); }
          else { Key(l, 0, c, 0x0004); Key(l, 0, c, 0x0004 | 0x0002); }
          sent++;
        }
        SendInput((uint)l.Count, l.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(15);
      }
      return sent;
    }
  }
}
'@
    [Jarvis.Win32]::InitDpi()
}

function Test-JarvisTarget($hwnd, $procId) {
    # Returns an error string, or $null when the window exists and still belongs to the expected PID.
    if (-not [Jarvis.Win32]::Exists([long]$hwnd)) { return 'The target window no longer exists' }
    if ([Jarvis.Win32]::PidOf([long]$hwnd) -ne [int]$procId) { return 'The target window no longer belongs to the approved process' }
    return $null
}
