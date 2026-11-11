import Foundation

enum HostPolicy {
    static func sessionToken(_ value: Any?) -> String? {
        guard let token=value as? String, token.utf8.count == 64,
              token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return token
    }

    static func sessionRequest(_ url: URL, token: String) -> URLRequest? {
        guard localOrigin(url.absoluteString) != nil, sessionToken(token) != nil else { return nil }
        var request=URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "X-Codex-Slider-Token")
        return request
    }

    static func localOrigin(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value), parts.scheme == "http",
              parts.host == "127.0.0.1", let port = parts.port, (1...65535).contains(port),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    static func isLocal(_ url: URL?, origin: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
            && url.user == nil && url.password == nil
    }

    static func externalLink(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == "chatgpt.com" && url.path == "/download"
            && url.user == nil && url.password == nil
    }

    // Developer-only offline validation uses external fixtures, never bundled test data.
    static func serviceArguments(_ arguments: [String]) throws -> [String] {
        if arguments.isEmpty { return ["--desktop"] }
        guard (arguments.count == 4 || arguments.count == 6), arguments[0] == "--offline-catalog", arguments[2] == "--data-dir",
              arguments[1].hasPrefix("/"), arguments[3].hasPrefix("/"),
              (arguments.count == 4 || (arguments[4] == "--offline-node" && arguments[5].hasPrefix("/"))) else {
            throw NSError(domain: "CodexSlider", code: 1, userInfo: [NSLocalizedDescriptionKey: "The application launch options are invalid."])
        }
        return ["--desktop", "--catalog-file", arguments[1], "--data-dir", arguments[3], "--disable-launch"]
    }

    static func offlineNode(_ arguments: [String]) throws -> String? {
        _ = try serviceArguments(arguments)
        return arguments.count == 6 ? arguments[5] : nil
    }

    static func compatibilityCommand(_ arguments: [String]) throws -> [String]? {
        if arguments.first == "--diagnose" {
            guard arguments.count == 1 || (arguments.count == 3 && arguments[1] == "--data-dir" && arguments[2].hasPrefix("/")) else {
                throw NSError(domain: "CodexSlider", code: 2, userInfo: [NSLocalizedDescriptionKey:"Use --diagnose with an optional absolute data directory."])
            }
            return ["--check"] + arguments.dropFirst()
        }
        let commands = ["--import-compatibility-list", "--check-compatibility-list", "--set-compatibility-url"]
        guard let first = arguments.first, commands.contains(first) else { return nil }
        guard arguments.count == 2 || (arguments.count == 4 && arguments[2] == "--data-dir" && arguments[3].hasPrefix("/")),
              first == "--set-compatibility-url" || arguments[1].hasPrefix("/") else {
            throw NSError(domain: "CodexSlider", code: 2, userInfo: [NSLocalizedDescriptionKey:"Use one compatibility command with an absolute list path and optional absolute data directory."])
        }
        return arguments
    }
}
