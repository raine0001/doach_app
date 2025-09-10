import SwiftUI
import WebKit
import AVFoundation
import Speech

struct WebAppView: UIViewRepresentable {
    let urlString: String
    private let speech = SpeechBridge()

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        config.mediaTypesRequiringUserActionForPlayback = []

        // JS -> native messages
        let ucc = WKUserContentController()
        ucc.add(context.coordinator, name: "doach") // {action:'startVoice'|'stopVoice'}
        config.userContentController = ucc

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        // Native -> JS transcript callback shim
        context.coordinator.onTranscript = { text in
            let escaped = text
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\n", with: "\\n")
            let js = "window.handleVoiceTranscript && window.handleVoiceTranscript('\(escaped)')"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
        context.coordinator.speech = speech

        // Ask mic early (improves UX)
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        SFSpeechRecognizer.requestAuthorization { _ in }

        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var speech: SpeechBridge?
        var onTranscript: ((String) -> Void)?

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
            default: break
            }
        }
    }
}
