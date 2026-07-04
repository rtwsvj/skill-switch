import Foundation
import SwiftUI

// 应用内语言切换:持久化偏好(`appLanguage`),"system" 时按系统首选解析成具体语言。
// 查表走 Bundle.module 下对应的 .lproj 子 bundle;找不到 key 时 fallback zh-Hans(产品母语)。
// @Published 触发 SwiftUI 重绘,切语言即时生效、无需重启。
@MainActor
final class L10n: ObservableObject {
    static let shared = L10n()

    /// 应用支持的语言代码(与 .lproj 目录名一致)。
    static let supportedLanguages: [String] = ["zh-Hans", "en", "ja", "es"]
    private static let storageKey = "appLanguage"

    /// "system" 跟随系统,或具体 zh-Hans / en / ja / es。
    @Published var language: String {
        didSet {
            // 写偏好的同时落盘;@Published 自身负责广播重绘。
            UserDefaults.standard.set(language, forKey: Self.storageKey)
        }
    }

    private init() {
        let stored = UserDefaults.standard.string(forKey: Self.storageKey) ?? "system"
        let valid = (stored == "system") || Self.supportedLanguages.contains(stored)
        self.language = valid ? stored : "system"
    }

    /// 把 "system" 解析成具体语言(按 Locale.preferredLanguages 前缀匹配,落不到就回 zh-Hans)。
    var resolved: String {
        if language != "system" { return language }
        let preferred = Locale.preferredLanguages.first?.lowercased() ?? ""
        // zh-Hant/zh-HK 等也落到简体(暂无繁体资源);日后加繁体需在此前置精确匹配。
        if preferred.hasPrefix("zh") { return "zh-Hans" }
        if preferred.hasPrefix("en") { return "en" }
        if preferred.hasPrefix("ja") { return "ja" }
        if preferred.hasPrefix("es") { return "es" }
        return "zh-Hans"
    }

    // .lproj 子 bundle 按语言缓存(内容不可变,无需失效);t() 被各视图高频调用,省掉每次的文件系统查找。
    private var bundleCache: [String: Bundle] = [:]

    private func bundle(for lang: String) -> Bundle {
        if let cached = bundleCache[lang] { return cached }
        let resolved: Bundle
        if let path = Bundle.module.path(forResource: lang, ofType: "lproj"),
           let b = Bundle(path: path) {
            resolved = b
        } else if let path = Bundle.module.path(forResource: "zh-Hans", ofType: "lproj"),
                  let b = Bundle(path: path) {
            // 兜底用 zh-Hans(产品母语);再不行回 Bundle.module。
            resolved = b
        } else {
            resolved = Bundle.module
        }
        bundleCache[lang] = resolved
        return resolved
    }

    func t(_ key: String) -> String {
        let b = bundle(for: resolved)
        let v = b.localizedString(forKey: key, value: nil, table: "Localizable")
        if v != key { return v }
        // 当前语言缺译 → 回退到 zh-Hans,再不行就返回 key 本身让 UI 留个明显的占位便于排查。
        let fb = bundle(for: "zh-Hans")
        let fv = fb.localizedString(forKey: key, value: nil, table: "Localizable")
        return fv != key ? fv : key
    }

    func t(_ key: String, _ args: CVarArg...) -> String {
        let format = t(key)
        // 用 withVaList 把 Swift 的 CVarArg 数组桥到 C 变参指针,NSString(format:arguments:) 吃这套。
        return withVaList(args) { ptr in
            NSString(format: format, arguments: ptr) as String
        }
    }
}
