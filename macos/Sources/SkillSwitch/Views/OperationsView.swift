import SwiftUI

struct OperationsView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared

    // 同步
    @State private var plan: SyncRunResult?
    @State private var planning = false
    @State private var planError: String?
    @State private var confirmSync = false

    // 安装
    @State private var source = ""
    @State private var agent = "claude-code"
    @State private var mode = "copy"
    @State private var force = false
    @State private var forceReason = ""
    @State private var confirmInstall = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScreenHeader(title: l10n.t("ops.title"),
                             subtitle: l10n.t("ops.subtitle")) {
                    Task { await state.reload() }
                }

                installCard
                syncCard
            }
            .padding(20)
        }
        .disabled(state.busy)
    }

    // ── 安装 ──────────────────────────────────────────────────────────
    @ViewBuilder private var installCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Label(l10n.t("ops.install.label"), systemImage: "square.and.arrow.down").font(.headline)
                Text(l10n.t("ops.install.intro"))
                    .font(.caption).foregroundStyle(.secondary)

                field(l10n.t("ops.install.field.source")) {
                    TextField(l10n.t("ops.install.field.source.placeholder"),
                              text: $source).textFieldStyle(.roundedBorder)
                }
                HStack {
                    field(l10n.t("ops.install.field.target")) {
                        TextField("claude-code", text: $agent).textFieldStyle(.roundedBorder).frame(width: 160)
                    }
                    field(l10n.t("ops.install.field.mode")) {
                        Picker("", selection: $mode) {
                            Text(l10n.t("ops.install.mode.copy")).tag("copy")
                            Text(l10n.t("ops.install.mode.symlink")).tag("symlink")
                        }.pickerStyle(.segmented).frame(width: 140)
                    }
                    Spacer()
                }
                Toggle(l10n.t("ops.install.force"), isOn: $force)
                    .toggleStyle(.checkbox).font(.callout)
                if force {
                    TextField(l10n.t("ops.install.force.reason"),
                              text: $forceReason).textFieldStyle(.roundedBorder)
                }

                HStack {
                    Button {
                        confirmInstall = true
                    } label: {
                        Label(l10n.t("ops.install.button"), systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(source.trimmingCharacters(in: .whitespaces).isEmpty
                              || (force && forceReason.trimmingCharacters(in: .whitespaces).isEmpty))
                    if state.busy { ProgressView().controlSize(.small) }
                }
            }
        }
        .confirmationDialog(l10n.t("ops.install.confirm.title"), isPresented: $confirmInstall) {
            Button(force ? l10n.t("ops.install.confirm.force.btn") : l10n.t("ops.install.confirm.normal.btn"),
                   role: force ? .destructive : nil) {
                Task { await state.install(source: source, agent: agent, mode: mode, force: force, forceReason: forceReason) }
            }
            Button(l10n.t("ops.install.confirm.cancel"), role: .cancel) {}
        } message: {
            Text(force ? l10n.t("ops.install.confirm.force.msg") : l10n.t("ops.install.confirm.normal.msg"))
        }
    }

    // ── 同步 ──────────────────────────────────────────────────────────
    @ViewBuilder private var syncCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Label(l10n.t("ops.sync.label"), systemImage: "arrow.triangle.2.circlepath").font(.headline)
                Text(l10n.t("ops.sync.intro"))
                    .font(.caption).foregroundStyle(.secondary)

                HStack {
                    Button {
                        Task { await preview() }
                    } label: { Label(l10n.t("ops.sync.preview.btn"), systemImage: "eye") }
                    .buttonStyle(.bordered)
                    if planning { ProgressView().controlSize(.small) }
                }

                if let planError {
                    Text(planError).font(.caption).foregroundStyle(.orange)
                }
                if let plan {
                    let changes = plan.actions.filter { $0.kind != "noop" }
                    if changes.isEmpty {
                        Text(l10n.t("ops.sync.empty")).font(.callout).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(l10n.t("ops.sync.changes", changes.count)).font(.callout.weight(.medium))
                            ForEach(changes) { a in
                                HStack {
                                    Pill(text: actionLabel(a.kind), tone: actionTone(a.kind))
                                    Text("\(a.name) · \(a.agent)").font(.caption)
                                    Spacer()
                                }
                            }
                            Button {
                                confirmSync = true
                            } label: { Label(l10n.t("ops.sync.apply.btn"), systemImage: "arrow.triangle.2.circlepath") }
                            .buttonStyle(.borderedProminent)
                            .padding(.top, 4)
                        }
                    }
                }
            }
        }
        .confirmationDialog(l10n.t("ops.sync.confirm.title"), isPresented: $confirmSync) {
            Button(l10n.t("ops.sync.confirm.btn")) { Task { await state.applySync(); plan = nil } }
            Button(l10n.t("ops.sync.confirm.cancel"), role: .cancel) {}
        } message: {
            Text(l10n.t("ops.sync.confirm.msg"))
        }
    }

    private func preview() async {
        planning = true; planError = nil; plan = nil
        do { plan = try await state.syncPlan() }
        catch {
            let msg = (error as? CLIError)?.message ?? error.localizedDescription
            planError = l10n.t("ops.sync.preview.failed", msg)
        }
        planning = false
    }

    private func actionLabel(_ kind: String) -> String {
        switch kind {
        case "create": return l10n.t("ops.action.create")
        case "replace": return l10n.t("ops.action.replace")
        case "remove": return l10n.t("ops.action.remove")
        case "config-enable": return l10n.t("ops.action.configEnable")
        case "config-disable": return l10n.t("ops.action.configDisable")
        default: return kind
        }
    }
    private func actionTone(_ kind: String) -> Tone {
        switch kind {
        case "remove": return .danger
        case "create", "config-enable": return .good
        default: return .warn
        }
    }

    @ViewBuilder private func field<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
    }
}
