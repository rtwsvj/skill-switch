import Foundation

// 数据模型 —— 镜像 gui/src/data/types.ts。CLI 用 `--json` 输出这些形状;
// Codable 自动忽略多余键,额外/可能缺失的字段一律 Optional,兼容旧 CLI。

enum AuditVerdict: String, Codable, Sendable { case SAFE, REVIEW, DANGER }
enum AuditSeverity: String, Codable, Sendable, CaseIterable { case critical, high, medium, low }

struct SkillRecord: Codable, Sendable, Identifiable, Hashable {
    var agents: [String] = []
    var relSkillsDir: String = ""
    var dirName: String = ""
    var dir: String = ""
    var path: String = ""
    var name: String?
    var description: String?
    var enabled: Bool?
    var error: String?

    var id: String { path.isEmpty ? dirName : path }
    var displayName: String { name ?? dirName }
}

struct ScanReport: Codable, Sendable {
    var home: String = ""
    var total: Int = 0
    var skills: [SkillRecord] = []
}

struct AuditFinding: Codable, Sendable, Hashable, Identifiable {
    var ruleId: String
    var severity: AuditSeverity
    var file: String
    var line: Int
    var excerpt: String
    var message: String
    var id: String { "\(ruleId)-\(file)-\(line)" }
}

struct AuditCoverage: Codable, Sendable {
    var scannedFiles: Int?
    var skippedFiles: Int?
    var tooLargeFiles: Int?
    var readErrors: Int?
    var truncated: Bool?
}

struct AuditReport: Codable, Sendable, Identifiable {
    var path: String = ""
    var findings: [AuditFinding] = []
    var score: Int = 100
    var verdict: AuditVerdict = .SAFE
    var name: String?
    var agents: [String]?
    var relSkillsDir: String?
    var blocked: Bool?
    var coverage: AuditCoverage?
    var id: String { name ?? path }
}

struct AuditHomeReport: Codable, Sendable {
    var home: String = ""
    var total: Int = 0
    var skills: [AuditReport] = []
    var crossSkillFindings: [AuditFinding]?
}

struct StatsUsage: Codable, Sendable, Identifiable, Hashable {
    var skill: String
    var count: Int
    var lastUsed: String?
    var id: String { skill }
}

struct StatsZombie: Codable, Sendable, Identifiable, Hashable {
    var name: String
    var agents: [String] = []
    var relSkillsDir: String = ""
    var id: String { name + relSkillsDir }
}

struct StatsReport: Codable, Sendable {
    var since: String?
    var scannedFiles: Int = 0
    var invocations: Int = 0
    var usage: [StatsUsage] = []
    var zombies: [StatsZombie] = []
    var skippedFiles: Int?
    var parseErrors: Int?
    var truncated: Bool?
}

struct DoctorFinding: Codable, Sendable, Identifiable, Hashable {
    var kind: String
    var agent: String
    var name: String
    var target: String?
    var detail: String
    var id: String { "\(kind)-\(agent)-\(name)" }
}

struct DoctorReport: Codable, Sendable {
    var findings: [DoctorFinding] = []
    var clean: Bool = true
    var legacyNames: [String]?
}

struct SnapshotView: Codable, Sendable, Identifiable, Hashable {
    var id: String { snapshotId ?? path }
    var snapshotId: String?
    var path: String = ""
    var label: String = ""
    var createdAt: String = ""
    var sourceDir: String?

    enum CodingKeys: String, CodingKey {
        case snapshotId = "id"
        case path, label, createdAt, sourceDir
    }
}

struct RestoreListResult: Codable, Sendable {
    var store: String = ""
    var snapshots: [SnapshotView] = []
}

// ── 写操作结果(镜像 gui/src/data/types.ts 的 *RunResult)──────────────────────

struct SyncAction: Codable, Sendable, Identifiable, Hashable {
    var kind: String
    var agent: String
    var name: String
    var target: String
    var reason: String?
    var id: String { "\(kind)-\(agent)-\(name)-\(target)" }
}

struct ToggleRunResult: Codable, Sendable {
    var name: String
    var enabled: Bool
    var declarationPath: String
    var snapshots: [SnapshotView] = []
    var actions: [SyncAction] = []
}

struct SyncRunResult: Codable, Sendable {
    var declarationPath: String
    var dryRun: Bool
    var snapshots: [SnapshotView] = []
    var actions: [SyncAction] = []
}

struct RemoveRunResult: Codable, Sendable {
    var name: String
    var agent: String
    var targetPath: String
    var snapshots: [SnapshotView] = []
}

struct RestoreRunResult: Codable, Sendable {
    var restored: Bool
    var target: String
    var snapshot: SnapshotView
    var safetySnapshot: SnapshotView
}

struct InstalledEntry: Codable, Sendable, Identifiable, Hashable {
    var name: String
    var targetPath: String
    var id: String { name + targetPath }
}

struct BlockedEntry: Codable, Sendable, Identifiable, Hashable {
    var name: String
    var score: Int
    var id: String { name }
}

struct InstallRunResult: Codable, Sendable {
    var installed: [InstalledEntry] = []
    var blocked: [BlockedEntry] = []
    var snapshotPath: String?
}

// ── MCP scan(镜像 src/cli/commands/mcp-scan.ts 的 toJson())────────────────
//
// list 模式(无 --server/--all,只列不连)与 scan 模式(--server/--all 命中)
// 是两个不同的 JSON 形状,所以建两个根类型。所有字段 Optional / 默认值,
// 容错于 CLI 后续新增字段。

enum McpTransport: String, Codable, Sendable {
    case stdio, http

    // 未知值不崩整条解码(否则 CLI 将来新增 transport 会让整个屏瘫痪)。
    // 兜底按 stdio:确认弹窗会用"将启动本地进程"的更重措辞,宁重勿轻。
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = McpTransport(rawValue: raw) ?? .stdio
    }
}

/// list 模式:`mcp-scan --json`(无 --server/--all)。CLI 输出一条单行 note。
struct McpScanListReport: Codable, Sendable {
    var home: String = ""
    var servers: [McpServerSummary] = []
    var note: String?
    /// list 模式无 baseline 概念;保留字段以兼容"未发现 server"时的同形输出。
    var baselinePath: String?
    var baselineStatus: String?
    var findings: [AuditFinding]?
}

struct McpServerSummary: Codable, Sendable, Identifiable, Hashable {
    var source: String = ""
    var name: String = ""
    var key: String = ""
    var transport: McpTransport = .stdio
    /// describe:CLI 给的「将执行 <command>」或「将请求 <url>」一行描述,UI 等宽显示。
    var describe: String = ""
    var id: String { key }
}

/// scan 模式:`mcp-scan --server <key> --yes --json`(可重复 / --all + --yes)。
struct McpScanReport: Codable, Sendable {
    var home: String = ""
    var baselinePath: String = ""
    var baselineStatus: String = "missing"
    var servers: [McpScanServerResult] = []
    var findings: [AuditFinding] = []
    /// list 模式会带;scan 模式没有也不需要。
    var note: String?
}

struct McpScanServerResult: Codable, Sendable, Identifiable, Hashable {
    var source: String = ""
    var name: String = ""
    var key: String = ""
    var transport: McpTransport = .stdio
    var connected: Bool = false
    var error: McpScanError?
    var protocolVersion: String?
    var tools: [McpScanTool] = []
    var findings: [AuditFinding] = []
    var rugPullFindings: [AuditFinding] = []
    var removedTools: [String] = []
    var id: String { key }

    /// 是否有 rug-pull 类发现(决定 UI 是否显示「重新接受」按钮)。
    var hasRugPull: Bool { !rugPullFindings.isEmpty }
}

struct McpScanError: Codable, Sendable, Hashable {
    var code: String = ""
    var message: String = ""
}

struct McpScanTool: Codable, Sendable, Identifiable, Hashable {
    var name: String = ""
    var description: String = ""
    var id: String { name }
}

/// UI 缓存:把单 server 的 scan 结果 + 本次扫描的基线状态绑在一起。
/// baselineStatus 在 CLI 的 JSON 顶层(McpScanReport),GUI 单 server 扫描时
/// report.servers 通常只有一条,顺势把根 status 挂到这一条上。
struct McpScanRow: Codable, Sendable, Hashable {
    var result: McpScanServerResult
    var baselineStatus: String = "missing"
}
