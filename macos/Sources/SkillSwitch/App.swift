import SwiftUI
import AppKit

// 裸 SPM 可执行文件默认以 accessory 策略启动、不显示窗口;设为 .regular 并激活,
// 让它作为普通 macOS 窗口 App 运行(开发/截图用;正式分发会打进 .app 包)。
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct SkillSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 900, minHeight: 600)
                .task { await state.reload() }
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(after: .toolbar) {
                Button(L10n.shared.t("status.menuRefresh")) { Task { await state.reload() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

enum Screen: String, CaseIterable, Identifiable {
    case overview, skills, safety, operations, history, usage
    var id: String { rawValue }

    // 标题从 L10n 取(@MainActor 因为 L10n.shared 在主线程);SwiftUI 视图 body 都是 MainActor,调用无碍。
    @MainActor var title: String {
        switch self {
        case .overview: return L10n.shared.t("nav.overview")
        case .skills: return L10n.shared.t("nav.skills")
        case .safety: return L10n.shared.t("nav.safety")
        case .operations: return L10n.shared.t("nav.ops")
        case .history: return L10n.shared.t("nav.history")
        case .usage: return L10n.shared.t("nav.usage")
        }
    }
    var icon: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .skills: return "puzzlepiece.extension"
        case .safety: return "checkmark.shield"
        case .operations: return "wrench.and.screwdriver"
        case .history: return "clock.arrow.circlepath"
        case .usage: return "chart.bar"
        }
    }
}

struct RootView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var l10n = L10n.shared
    @State private var selection: Screen = .overview

    var body: some View {
        NavigationSplitView {
            List(Screen.allCases, selection: $selection) { screen in
                Label(screen.title, systemImage: screen.icon).tag(screen)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Divider()
                    HStack(spacing: 6) {
                        Circle().fill(state.fatalError == nil ? Color.green : Color.red).frame(width: 7, height: 7)
                        Text(state.fatalError == nil
                             ? l10n.t("status.cliConnected")
                             : l10n.t("status.cliDisconnected"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let at = state.loadedAt {
                        Text(l10n.t("status.refreshedAt", at.formatted(date: .omitted, time: .shortened)))
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
            }
        } detail: {
            Group {
                switch selection {
                case .overview: OverviewView()
                case .skills: SkillsView()
                case .safety: SafetyView()
                case .operations: OperationsView()
                case .history: HistoryView()
                case .usage: UsageView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("skill-switch").font(.headline) }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await state.reload() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }.help(l10n.t("status.toolbarRefresh")).disabled(state.isLoading)
                }
                ToolbarItem(placement: .primaryAction) { languageMenu }
            }
        }
        .overlay(alignment: .top) {
            if let err = state.fatalError {
                Text(err)
                    .font(.callout)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                    .padding()
            }
        }
        .overlay(alignment: .bottom) { banner }
    }

    // 语言切换入口:toolbar 上的地球图标菜单,跟随系统 + 四种具体语言。
    private var languageMenu: some View {
        Menu {
            ForEach(Self.languageOptions, id: \.code) { opt in
                Button {
                    l10n.language = opt.code
                } label: {
                    if l10n.language == opt.code {
                        Label(l10n.t(opt.labelKey), systemImage: "checkmark")
                    } else {
                        Text(l10n.t(opt.labelKey))
                    }
                }
            }
        } label: {
            Image(systemName: "globe")
        }
        .help(l10n.t("language.menu"))
    }

    // 菜单项 = (内部代码, 翻译 key)。写死而不是动态拼 "language." + code,让 i18n 检查能直接看到每个 key。
    private static let languageOptions: [(code: String, labelKey: String)] = [
        ("system", "language.system"),
        ("zh-Hans", "language.zhHans"),
        ("en", "language.en"),
        ("ja", "language.ja"),
        ("es", "language.es"),
    ]

    // 写操作反馈:成功(绿)/ 失败(红)/ 处理中。3 秒后自动消失。
    @ViewBuilder private var banner: some View {
        if state.busy {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(l10n.t("status.processing")) }
                .padding(10).background(.regularMaterial, in: Capsule()).padding(.bottom, 16)
        } else if let msg = state.toast {
            Label(msg, systemImage: "checkmark.circle.fill")
                .font(.callout).foregroundStyle(.green)
                .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task { try? await Task.sleep(for: .seconds(3.5)); state.toast = nil }
        } else if let err = state.actionError {
            Label(err, systemImage: "exclamationmark.triangle.fill")
                .font(.callout).foregroundStyle(.red)
                .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task { try? await Task.sleep(for: .seconds(5)); state.actionError = nil }
        }
    }
}