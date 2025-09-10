import Foundation
import AVFoundation
import Speech

final class SpeechBridge: NSObject {
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    func start(onFinal: @escaping (String) -> Void) {
        stop()

        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.mixWithOthers, .defaultToSpeaker])
        try? session.setActive(true, options: .notifyOthersOnDeactivation)

        request = SFSpeechAudioBufferRecognitionRequest()
        request?.shouldReportPartialResults = false

        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] (buffer, _) in
            self?.request?.append(buffer)
        }

        audio.prepare()
        try? audio.start()

        task = recognizer?.recognitionTask(with: request!) { [weak self] result, error in
            if let txt = result?.bestTranscription.formattedString, result?.isFinal == true {
                onFinal(txt)
            }
            if error != nil || (result?.isFinal ?? false) {
                self?.stop()
            }
        }
    }

    func stop() {
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
