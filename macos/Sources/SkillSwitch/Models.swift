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
