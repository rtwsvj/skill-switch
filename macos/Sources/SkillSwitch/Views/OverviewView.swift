import SwiftUI

struct OverviewView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared
    private let cols = [GridItem(.adaptive(minimum: 200), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("nav.overview"),
                             subtitle: state.homeOverride != nil ? l10n.t("overview.demoHome") : nil) {
                    Task { await state.reload() }
                }

                LazyVGrid(columns: cols, spacing: 14) {
                    MetricCard(icon: "cpu", value: "\(state.agentCount)",
                               label: l10n.t("overview.metrics.agents"), tone: .accent)
                    MetricCard(icon: "puzzlepiece.extension", value: "\(state.skillCount)",
                               label: l10n.t("overview.metrics.skills"))
                    MetricCard(icon: "moon.zzz", value: "\(state.zombieCount)",
                               label: l10n.t("overview.metrics.zombies"),
                               tone: state.zombieCount > 0 ? .warn : .neutral)
                    MetricCard(icon: state.healthOK ? "heart.text.square" : "exclamationmark.triangle",
                               value: state.healthOK ? l10n.t("overview.metrics.health.ok") : "\(state.doctorIssueCount)",
                               label: l10n.t("overview.metrics.health.label"),
                               tone: state.healthOK ? .good : .danger)
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
                    Label(l10n.t("overview.attention"), systemImage: "bell.badge").font(.headline)
                    Spacer()
                    Pill(text: l10n.t("overview.attention.count", blocked.count + mismatches.count),
                         tone: (blocked.count + mismatches.count) > 0 ? .warn : .neutral)
                }
                if blocked.isEmpty && mismatches.isEmpty {
                    Text(l10n.t("overview.attention.empty")).font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(blocked) { r in
                        HStack {
                            Image(systemName: "exclamationmark.octagon.fill").foregroundStyle(.red)
                            Text(r.name ?? r.path)
                            Spacer()
                            Pill(text: l10n.t("overview.attention.blocked", r.score), tone: .danger)
                        }
                    }
                    ForEach(mismatches) { s in
                        HStack {
                            Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
                            Text(s.displayName)
                            Spacer()
                            Pill(text: l10n.t("overview.attention.readFailed"), tone: .warn)
                        }
                    }
                }
            }
        }
    }
}