import SwiftUI

struct UsageView: View {
    @EnvironmentObject var state: AppState
    private let cols = [GridItem(.adaptive(minimum: 170), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "使用", subtitle: state.stats.since.map { "自 \($0)" } ?? "全部时间") {
                    Task { await state.reload() }
                }

                LazyVGrid(columns: cols, spacing: 14) {
                    MetricCard(icon: "doc.text.magnifyingglass", value: "\(state.stats.scannedFiles)", label: "已扫描记录")
                    MetricCard(icon: "bolt.fill", value: "\(state.stats.invocations)", label: "技能调用", tone: .accent)
                    MetricCard(icon: "checkmark.circle", value: "\(state.stats.usage.count)", label: "用过的技能", tone: .good)
                    MetricCard(icon: "moon.zzz.fill", value: "\(state.stats.zombies.count)", label: "从未用过",
                               tone: state.stats.zombies.isEmpty ? .neutral : .warn)
                }

                if !state.stats.usage.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("调用最多").font(.headline)
                            ForEach(state.stats.usage.prefix(10)) { u in
                                HStack {
                                    Text(u.skill)
                                    Spacer()
                                    Pill(text: "\(u.count) 次", tone: .accent)
                                }
                            }
                        }
                    }
                }

                Card(tone: state.stats.zombies.isEmpty ? .neutral : .warn) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("从未用过的技能", systemImage: "moon.zzz").font(.headline)
                        if state.stats.zombies.isEmpty {
                            Text("没有僵尸技能。").font(.callout).foregroundStyle(.secondary)
                        } else {
                            ForEach(state.stats.zombies) { z in
                                HStack {
                                    Text(z.name)
                                    Spacer()
                                    ForEach(z.agents, id: \.self) { Pill(text: $0, tone: .neutral) }
                                    Pill(text: "从未用过", tone: .warn)
                                }
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
    }
}
