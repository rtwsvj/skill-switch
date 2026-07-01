import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var state: AppState
    @State private var snapshots: [SnapshotView] = []
    @State private var loading = false
    @State private var error: String?
    @State private var pendingRestore: SnapshotView?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: "历史", subtitle: "\(snapshots.count) 个备份") {
                    Task { await load() }
                }
                Text("你的「后悔药」:每次改动前都会自动备份,随时可一键还原回某个时间点。")
                    .font(.callout).foregroundStyle(.secondary)

                if loading {
                    ProgressView().padding()
                } else if let error {
                    Card(tone: .warn) { Text(error).font(.callout).foregroundStyle(.secondary) }
                } else if snapshots.isEmpty {
                    Card { Text("还没有备份记录。做过改动后,这里会出现可还原的时间点。").foregroundStyle(.secondary) }
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
                                    Label("还原到此", systemImage: "arrow.uturn.backward")
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
            "还原这个备份?",
            isPresented: Binding(get: { pendingRestore != nil }, set: { if !$0 { pendingRestore = nil } }),
            presenting: pendingRestore
        ) { snap in
            Button("还原") {
                if let id = snap.snapshotId {
                    Task { await state.restore(snapshotId: id); await load() }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { snap in
            Text("会用「\(snap.label)」覆盖当前状态。覆盖前会再自动备份当前状态,仍可还原回来。")
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
            self.error = "加载备份失败:\((error as? CLIError)?.message ?? error.localizedDescription)"
            snapshots = []
        }
        loading = false
    }
}
