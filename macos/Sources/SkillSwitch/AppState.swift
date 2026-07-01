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

        if let s { scan = s } else { sectionErrors["scan"] = "加载失败" }
        if let a { audit = a } else { sectionErrors["audit"] = "加载失败" }
        if let st { stats = st } else { sectionErrors["stats"] = "加载失败" }
        if let d { doctor = d } else { sectionErrors["doctor"] = "加载失败" }

        // 四块全挂 → 大概率 CLI 路径不通,给出可操作的致命提示。
        if s == nil && a == nil && st == nil && d == nil {
            fatalError = "调不到 skill-switch CLI。请设环境变量 SKILL_SWITCH_ROOT=<仓库根> 或 SKILL_SWITCH_CLI=<可执行文件>。"
        }

        loadedAt = Date()
        isLoading = false
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
