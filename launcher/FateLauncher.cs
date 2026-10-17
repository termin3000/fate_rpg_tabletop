using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// A Windows Job owns the whole tree, including a localtunnel grandchild.
// Closing the launcher handle also cleans up after a forced launcher exit.
public sealed class FateLauncher : Form {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    IntPtr job;
    Process server;
    TextBox output;
    bool headless;
    public FateLauncher(bool hidden) {
        headless = hidden;
        Text = "Fate RPG";
        Width = 640; Height = 310; StartPosition = FormStartPosition.CenterScreen;
        output = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
        var exit = new Button { Text = "Выход — остановить приложение", Dock = DockStyle.Bottom, Height = 42 };
        exit.Click += delegate { Close(); };
        Controls.Add(output); Controls.Add(exit);
        FormClosed += delegate { Cleanup(); };
    }
    void Cleanup() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
    void WriteLine(string line) {
        if (String.IsNullOrEmpty(line) || headless || !IsHandleCreated || IsDisposed) return;
        try { BeginInvoke((Action)(() => output.AppendText(line + Environment.NewLine))); } catch (InvalidOperationException) { }
    }
    public void StartServer() {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string bundle = File.Exists(Path.Combine(root, "server.js")) ? root : Path.Combine(root, ".next", "standalone");
        string runtime = Path.Combine(bundle, "runtime", "node.exe");
        if (!File.Exists(runtime)) throw new Exception("Сборка не найдена. Сначала запустите build.bat.");
        job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(limits);
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, ptr, false);
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ptr, (uint)size)) throw new Exception("Не удалось создать группу процессов приложения.");
        } finally { Marshal.FreeHGlobal(ptr); }
        var start = new ProcessStartInfo(runtime, "\"" + Path.Combine(bundle, "scripts", "start-all.cjs") + "\"");
        start.WorkingDirectory = root;
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.EnvironmentVariables["FATE_DATA_ROOT"] = root;
        start.EnvironmentVariables["FATE_LAUNCHER_WAIT"] = "1";
        if (headless) start.EnvironmentVariables["FATE_NO_BROWSER"] = "1";
        server = new Process { StartInfo = start, EnableRaisingEvents = true };
        server.OutputDataReceived += (sender, e) => WriteLine(e.Data);
        server.ErrorDataReceived += (sender, e) => WriteLine(e.Data);
        server.Exited += delegate {
            if (!headless && IsHandleCreated && !IsDisposed) {
                try { BeginInvoke((Action)(() => {
                    if (server.ExitCode != 0) MessageBox.Show("Не удалось запустить приложение. Проверьте logs/runtime.log и закройте предыдущий экземпляр.", "Fate RPG");
                    Close();
                })); } catch (InvalidOperationException) { }
            }
        };
        server.Start();
        if (!AssignProcessToJobObject(job, server.Handle)) {
            server.Kill();
            throw new Exception("Не удалось привязать сервисы к окну приложения.");
        }
        server.BeginOutputReadLine(); server.BeginErrorReadLine();
        server.StandardInput.WriteLine("start"); server.StandardInput.Flush();
    }
    [STAThread] public static void Main(string[] args) {
        bool headless = Array.IndexOf(args, "--headless") >= 0;
        Application.EnableVisualStyles();
        using (var app = new FateLauncher(headless)) {
            try {
                if (headless) { app.StartServer(); app.server.WaitForExit(); app.Cleanup(); Environment.ExitCode = app.server.ExitCode; }
                else { app.Shown += delegate { try { app.StartServer(); } catch (Exception e) { MessageBox.Show(e.Message, "Fate RPG"); app.Cleanup(); app.Close(); } }; Application.Run(app); }
            } catch (Exception e) { app.Cleanup(); if (!headless) MessageBox.Show(e.Message, "Fate RPG"); Environment.ExitCode = 1; }
        }
    }
}
