import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared
    @State private var snapshots: [SnapshotView] = []
    @State private var loading = false
    @State private var error: String?
    @State private var pendingRestore: SnapshotView?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("nav.history"),
                             subtitle: l10n.t("history.subtitle.count", snapshots.count)) {
                    Task { await load() }
                }
                Text(l10n.t("history.intro"))
                    .font(.callout).foregroundStyle(.secondary)

                if loading {
                    ProgressView().padding()
                } else if let error {
                    Card(tone: .warn) { Text(error).font(.callout).foregroundStyle(.secondary) }
                } else if snapshots.isEmpty {
                    Card { Text(l10n.t("history.empty")).foregroundStyle(.secondary) }
                } else {
                    ForEach(snapshots) { snap in
                        Card {
                            HStack {
                                Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(snap.label).font(.callout.weight(.medium))
                                    Text(snap.createdAt).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Button {
                                    pendingRestore = snap
                                } label: {
                                    Label(l10n.t("history.action.restore"), systemImage: "arrow.uturn.backward")
                                }
                                .buttonStyle(.bordered)
                                .disabled(snap.snapshotId == nil || state.busy)
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
        .task { await load() }
        .confirmationDialog(
            l10n.t("history.confirm.title"),
            isPresented: Binding(get: { pendingRestore != nil }, set: { if !$0 { pendingRestore = nil } }),
            presenting: pendingRestore
        ) { snap in
            Button(l10n.t("history.confirm.btn")) {
                if let id = snap.snapshotId {
                    Task { await state.restore(snapshotId: id); await load() }
                }
            }
            Button(l10n.t("history.confirm.cancel"), role: .cancel) {}
        } message: { snap in
            Text(l10n.t("history.confirm.msg", snap.label))
        }
    }

    private func load() async {
        loading = true
        error = nil
        var args = ["restore", "--json"]
        if let h = state.homeOverride, !h.isEmpty { args += ["--home", h] }
        do {
            let result = try await CLI.runJSON(args, as: RestoreListResult.self)
            snapshots = result.snapshots
        } catch {
            let msg = (error as? CLIError)?.message ?? error.localizedDescription
            // catch 内部 error 同名遮蔽,用 l10n 时不会引用 self,但这里要保留上层 self.error 的赋值
            self.error = l10n.t("history.load.failed", msg)
            snapshots = []
        }
        loading = false
    }
}