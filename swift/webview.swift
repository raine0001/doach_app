import SwiftUI
import WebKit
import AVFoundation
import Speech

struct WebAppView: UIViewRepresentable {
    let url: URL
    var session: AuthSession?
    private let speech = SpeechBridge()

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        config.mediaTypesRequiringUserActionForPlayback = []

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "doach")
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        context.coordinator.onTranscript = { text in
            let escaped = text
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            let js = "window.handleVoiceTranscript && window.handleVoiceTranscript('\(escaped)')"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        context.coordinator.speech = speech

        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        SFSpeechRecognizer.requestAuthorization { _ in }

        context.coordinator.load(url: url, session: session, into: webView)

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.load(url: url, session: session, into: uiView)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var speech: SpeechBridge?
        var onTranscript: ((String) -> Void)?
        private var lastURL: URL?
        private var lastSessionSignature: String?

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "doach",
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            switch action {
            case "startVoice":
                speech?.start { [weak self] text in self?.onTranscript?(text) }
            case "stopVoice":
                speech?.stop()
            default:
                break
            }
        }

        func load(url: URL, session: AuthSession?, into webView: WKWebView) {
            let sessionSignature = session?.signature
            let needsReload = lastURL != url || lastSessionSignature != sessionSignature
            guard needsReload else { return }

            lastURL = url
            lastSessionSignature = sessionSignature

            let applyRequest = {
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
                if let token = session?.accessToken {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                if let csrf = session?.headerValue(forCaseInsensitiveKey: "X-CSRF-Token") {
                    request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
                }
                webView.load(request)
            }

            guard let session else {
                applyRequest()
                return
            }

            let store = webView.configuration.websiteDataStore.httpCookieStore
            let group = DispatchGroup()
            for cookie in session.cookies {
                group.enter()
                store.setCookie(cookie) {
                    group.leave()
                }
            }
            group.notify(queue: .main, execute: applyRequest)
        }
    }
}
