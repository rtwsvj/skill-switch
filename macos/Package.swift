// swift-tools-version: 6.0
import PackageDescription

// skill-switch 的原生 macOS 前端(SwiftUI)。壳外调用现有 `skill-switch` CLI(--json)取数据,
// 用原生视图渲染。核心引擎(TS CLI)一行不动。
let package = Package(
    name: "SkillSwitch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SkillSwitch",
            path: "Sources/SkillSwitch"
        )
    ]
)
