import SwiftUI

struct UsageView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared
    private let cols = [GridItem(.adaptive(minimum: 170), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("nav.usage"),
                             subtitle: state.stats.since.map { l10n.t("usage.since.since", $0) }
                                        ?? l10n.t("usage.since.all")) {
                    Task { await state.reload() }
                }

                LazyVGrid(columns: cols, spacing: 14) {
                    MetricCard(icon: "doc.text.magnifyingglass", value: "\(state.stats.scannedFiles)",
                               label: l10n.t("usage.metric.scanned"))
                    MetricCard(icon: "bolt.fill", value: "\(state.stats.invocations)",
                               label: l10n.t("usage.metric.invocations"), tone: .accent)
                    MetricCard(icon: "checkmark.circle", value: "\(state.stats.usage.count)",
                               label: l10n.t("usage.metric.used"), tone: .good)
                    MetricCard(icon: "moon.zzz.fill", value: "\(state.stats.zombies.count)",
                               label: l10n.t("usage.metric.zombies"),
                               tone: state.stats.zombies.isEmpty ? .neutral : .warn)
                }

                if !state.stats.usage.isEmpty {
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(l10n.t("usage.topTitle")).font(.headline)
                            ForEach(state.stats.usage.prefix(10)) { u in
                                HStack {
                                    Text(u.skill)
                                    Spacer()
                                    Pill(text: l10n.t("usage.count", u.count), tone: .accent)
                                }
                            }
                        }
                    }
                }

                Card(tone: state.stats.zombies.isEmpty ? .neutral : .warn) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(l10n.t("usage.zombies.label"), systemImage: "moon.zzz").font(.headline)
                        if state.stats.zombies.isEmpty {
                            Text(l10n.t("usage.zombies.empty")).font(.callout).foregroundStyle(.secondary)
                        } else {
                            ForEach(state.stats.zombies) { z in
                                HStack {
                                    Text(z.name)
                                    Spacer()
                                    ForEach(z.agents, id: \.self) { Pill(text: $0, tone: .neutral) }
                                    Pill(text: l10n.t("usage.zombies.pill"), tone: .warn)
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
