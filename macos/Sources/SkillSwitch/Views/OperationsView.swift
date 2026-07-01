import SwiftUI

struct OperationsView: View {
    @EnvironmentObject var state: AppState

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
                ScreenHeader(title: "安装与维护",
                             subtitle: "所有写操作先自动备份,可一键回滚") {
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
                Label("安装", systemImage: "square.and.arrow.down").font(.headline)
                Text("把新技能放进所选工具;安装前先做安全检查,危险源默认拦下。")
                    .font(.caption).foregroundStyle(.secondary)

                field("来源") {
                    TextField("Git 地址或本地文件夹", text: $source).textFieldStyle(.roundedBorder)
                }
                HStack {
                    field("装到") {
                        TextField("claude-code", text: $agent).textFieldStyle(.roundedBorder).frame(width: 160)
                    }
                    field("保存方式") {
                        Picker("", selection: $mode) {
                            Text("复制").tag("copy"); Text("链接").tag("symlink")
                        }.pickerStyle(.segmented).frame(width: 140)
                    }
                    Spacer()
                }
                Toggle("遇到安全拦截也继续(风险自负)", isOn: $force)
                    .toggleStyle(.checkbox).font(.callout)
                if force {
                    TextField("仍要安装的理由(必填,会留痕)", text: $forceReason).textFieldStyle(.roundedBorder)
                }

                HStack {
                    Button {
                        confirmInstall = true
                    } label: {
                        Label("安装", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(source.trimmingCharacters(in: .whitespaces).isEmpty
                              || (force && forceReason.trimmingCharacters(in: .whitespaces).isEmpty))
                    if state.busy { ProgressView().controlSize(.small) }
                }
            }
        }
        .confirmationDialog("要安装这个技能吗?", isPresented: $confirmInstall) {
            Button(force ? "跳过拦截并安装" : "安装", role: force ? .destructive : nil) {
                Task { await state.install(source: source, agent: agent, mode: mode, force: force, forceReason: forceReason) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text(force ? "会跳过安全拦截继续安装。仅在确认来源可信时继续。"
                       : "安装前会先做安全检查,通过后才写入。改动前自动备份。")
        }
    }

    // ── 同步 ──────────────────────────────────────────────────────────
    @ViewBuilder private var syncCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Label("同步", systemImage: "arrow.triangle.2.circlepath").font(.headline)
                Text("按已保存的清单重新整理技能,修复缺失或不一致。先预览再应用。")
                    .font(.caption).foregroundStyle(.secondary)

                HStack {
                    Button {
                        Task { await preview() }
                    } label: { Label("先预览", systemImage: "eye") }
                    .buttonStyle(.bordered)
                    if planning { ProgressView().controlSize(.small) }
                }

                if let planError {
                    Text(planError).font(.caption).foregroundStyle(.orange)
                }
                if let plan {
                    let changes = plan.actions.filter { $0.kind != "noop" }
                    if changes.isEmpty {
                        Text("清单与磁盘一致,无需同步。").font(.callout).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(changes.count) 项会变化:").font(.callout.weight(.medium))
                            ForEach(changes) { a in
                                HStack {
                                    Pill(text: actionLabel(a.kind), tone: actionTone(a.kind))
                                    Text("\(a.name) · \(a.agent)").font(.caption)
                                    Spacer()
                                }
                            }
                            Button {
                                confirmSync = true
                            } label: { Label("开始同步", systemImage: "arrow.triangle.2.circlepath") }
                            .buttonStyle(.borderedProminent)
                            .padding(.top, 4)
                        }
                    }
                }
            }
        }
        .confirmationDialog("应用同步变更?", isPresented: $confirmSync) {
            Button("开始同步") { Task { await state.applySync(); plan = nil } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("按清单把技能应用到磁盘。改动前会自动备份,可从「历史」还原。")
        }
    }

    private func preview() async {
        planning = true; planError = nil; plan = nil
        do { plan = try await state.syncPlan() }
        catch { planError = "预览失败:\((error as? CLIError)?.message ?? error.localizedDescription)" }
        planning = false
    }

    private func actionLabel(_ kind: String) -> String {
        switch kind {
        case "create": return "新建"
        case "replace": return "更新"
        case "remove": return "移除"
        case "config-enable": return "启用"
        case "config-disable": return "停用"
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
