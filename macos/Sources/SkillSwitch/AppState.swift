import SwiftUI

// 全局数据存储。并行拉 scan / audit / stats / doctor;任一区块失败只记错误、不白屏。
// `homeOverride` 非空时给所有命令加 `--home`(试手/演示用,不碰真实配置)。

@MainActor
final class AppState: ObservableObject {
    @Published var scan: ScanReport = .init()
    @Published var audit: AuditHomeReport = .init()
    @Published var stats: StatsReport = .init()
    @Published var doctor: DoctorReport = .init()

    @Published var isLoading = false
    @Published var loadedAt: Date?
    @Published var fatalError: String?
    @Published var sectionErrors: [String: String] = [:]

    // 写操作状态
    @Published var busy = false
    @Published var toast: String?
    @Published var actionError: String?

    /// 非 nil 时所有命令加 `--home <path>`。缺省读环境变量 SKILL_SWITCH_HOME;
    /// 都没有则 nil = 操作真实配置目录。
    @Published var homeOverride: String?

    init() {
        if let h = ProcessInfo.processInfo.environment["SKILL_SWITCH_HOME"], !h.isEmpty {
            homeOverride = h
        }
    }

    private func homeArgs() -> [String] {
        if let h = homeOverride, !h.isEmpty { return ["--home", h] }
        return []
    }

    func reload() async {
        isLoading = true
        fatalError = nil
        sectionErrors = [:]
        let home = homeArgs()

        // 并行拉四块;各自 try? 容错,失败记 sectionErrors。
        async let scanR: ScanReport? = try? CLI.runJSON(["scan", "--json"] + home, as: ScanReport.self)
        async let auditR: AuditHomeReport? = try? CLI.runJSON(["audit", "--json"] + home, as: AuditHomeReport.self)
        async let statsR: StatsReport? = try? CLI.runJSON(["stats", "--json"] + home, as: StatsReport.self)
        async let doctorR: DoctorReport? = try? CLI.runJSON(["doctor", "--json"] + home, as: DoctorReport.self)

        let (s, a, st, d) = await (scanR, auditR, statsR, doctorR)

        let failedLabel = L10n.shared.t("status.sectionLoadFailed")
        if let s { scan = s } else { sectionErrors["scan"] = failedLabel }
        if let a { audit = a } else { sectionErrors["audit"] = failedLabel }
        if let st { stats = st } else { sectionErrors["stats"] = failedLabel }
        if let d { doctor = d } else { sectionErrors["doctor"] = failedLabel }

        // 四块全挂 → 大概率 CLI 路径不通,给出可操作的致命提示。
        if s == nil && a == nil && st == nil && d == nil {
            fatalError = L10n.shared.t("status.fatalCliNotFound")
        }

        loadedAt = Date()
        isLoading = false
    }

    // ── 写操作 ────────────────────────────────────────────────────────
    // 全部复用 CLI 的护栏:装前审计 + 写前快照。这里只负责调用 + 报告 + 重载。

    private func snapshotNote(_ snaps: [SnapshotView]) -> String {
        if let s = snaps.first {
            return L10n.shared.t("ops.snapshotWithLabel", s.label)
        }
        return ""
    }

    /// 通用写操作外壳:置 busy → 跑 op → 成功记 toast + 重载,失败记 actionError。
    private func runWrite(_ label: String, _ op: @escaping () async throws -> String) async {
        busy = true
        actionError = nil
        toast = nil
        do {
            let msg = try await op()
            toast = msg
            await reload()
        } catch {
            let errMsg = (error as? CLIError)?.message ?? error.localizedDescription
            actionError = L10n.shared.t("ops.failed", label, errMsg)
        }
        busy = false
    }

    func toggle(_ name: String, enabled: Bool) async {
        let actionLabel = L10n.shared.t(enabled ? "ops.toggle.enable" : "ops.toggle.disable")
        await runWrite(actionLabel) {
            let r = try await CLI.runJSON(
                ["toggle", name, enabled ? "--on" : "--off", "--json"] + self.homeArgs(),
                as: ToggleRunResult.self)
            return L10n.shared.t(enabled ? "ops.toggle.ok.enabled" : "ops.toggle.ok.disabled",
                                 r.name, self.snapshotNote(r.snapshots))
        }
    }

    func remove(_ name: String, agent: String) async {
        await runWrite(L10n.shared.t("ops.remove")) {
            let r = try await CLI.runJSON(
                ["remove", name, "--agent", agent, "--json"] + self.homeArgs(),
                as: RemoveRunResult.self)
            return L10n.shared.t("ops.remove.ok", r.name, r.agent, self.snapshotNote(r.snapshots))
        }
    }

    func applySync() async {
        await runWrite(L10n.shared.t("ops.sync")) {
            let r = try await CLI.runJSON(["sync", "--json"] + self.homeArgs(), as: SyncRunResult.self)
            let n = r.actions.filter { $0.kind != "noop" }.count
            return L10n.shared.t("ops.sync.ok", n, self.snapshotNote(r.snapshots))
        }
    }

    /// 同步预览(dry-run):不写盘、不重载,直接返回计划供 UI 展示。
    func syncPlan() async throws -> SyncRunResult {
        try await CLI.runJSON(["sync", "--dry-run", "--json"] + homeArgs(), as: SyncRunResult.self)
    }

    func restore(snapshotId: String) async {
        await runWrite(L10n.shared.t("ops.restore")) {
            let r = try await CLI.runJSON(
                ["restore", "--id", snapshotId, "--json"] + self.homeArgs(),
                as: RestoreRunResult.self)
            return L10n.shared.t("ops.restore.ok", r.snapshot.label)
        }
    }

    func install(source: String, agent: String, mode: String, force: Bool, forceReason: String) async {
        await runWrite(L10n.shared.t("ops.install")) {
            var args = ["install", source, "--agent", agent, "--mode", mode]
            if force { args += ["--force"] }
            if force, !forceReason.trimmingCharacters(in: .whitespaces).isEmpty {
                args += ["--force-reason", forceReason.trimmingCharacters(in: .whitespaces)]
            }
            args.append("--json")
            let r = try await CLI.runJSON(args + self.homeArgs(), as: InstallRunResult.self)
            if !r.blocked.isEmpty {
                return L10n.shared.t("ops.install.blocked", r.blocked.count)
            }
            let snap = r.snapshotPath != nil ? L10n.shared.t("ops.snapshotPrefix") : ""
            let sep = L10n.shared.t("ops.install.listSeparator")
            let names = r.installed.map { $0.name }.joined(separator: sep)
            return L10n.shared.t("ops.install.ok", names, snap)
        }
    }

    // ── 派生指标(总览用)──────────────────────────────────────────────
    var agentCount: Int { Set(scan.skills.flatMap { $0.agents }).count }
    var skillCount: Int { scan.total }
    var zombieCount: Int { stats.zombies.count }
    var blockedCount: Int { audit.skills.filter { $0.blocked == true }.count }
    var reviewCount: Int { audit.skills.filter { $0.verdict == .REVIEW }.count }
    var safeCount: Int { audit.skills.filter { $0.verdict == .SAFE && !($0.blocked ?? false) }.count }
    var doctorIssueCount: Int { doctor.findings.count }
    var healthOK: Bool { doctor.clean }
}