import SwiftUI

struct OverviewView: View {
    @EnvironmentObject var state: AppState
    private let cols = [GridItem(.adaptive(minimum: 200), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "总览", subtitle: state.homeOverride != nil ? "演示目录(不碰真实配置)" : nil) {
                    Task { await state.reload() }
                }

                LazyVGrid(columns: cols, spacing: 14) {
                    MetricCard(icon: "cpu", value: "\(state.agentCount)", label: "已接入的工具", tone: .accent)
                    MetricCard(icon: "puzzlepiece.extension", value: "\(state.skillCount)", label: "技能总数")
                    MetricCard(icon: "moon.zzz", value: "\(state.zombieCount)", label: "从未用过",
                               tone: state.zombieCount > 0 ? .warn : .neutral)
                    MetricCard(icon: state.healthOK ? "heart.text.square" : "exclamationmark.triangle",
                               value: state.healthOK ? "正常" : "\(state.doctorIssueCount)",
                               label: "健康检查", tone: state.healthOK ? .good : .danger)
                }

                attention
            }
            .padding(20)
        }
    }

    @ViewBuilder private var attention: some View {
        let blocked = state.audit.skills.filter { $0.blocked == true }
        let mismatches = state.scan.skills.filter { $0.error != nil }
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("关注队列", systemImage: "bell.badge").font(.headline)
                    Spacer()
                    Pill(text: "\(blocked.count + mismatches.count) 项",
                         tone: (blocked.count + mismatches.count) > 0 ? .warn : .neutral)
                }
                if blocked.isEmpty && mismatches.isEmpty {
                    Text("目前没有需要处理的问题。").font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(blocked) { r in
                        HStack {
                            Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(.red)
                            Text(r.name ?? r.path)
                            Spacer()
                            Pill(text: "被拦下 · 评分 \(r.score)", tone: .danger)
                        }
                    }
                    ForEach(mismatches) { s in
                        HStack {
                            Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
                            Text(s.displayName)
                            Spacer()
                            Pill(text: "读取失败", tone: .warn)
                        }
                    }
                }
            }
        }
    }
}
