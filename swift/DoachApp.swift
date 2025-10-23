import SwiftUI

@main
struct DoachApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var isRegistered = false
    @State private var authSession: AuthSession?

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if isRegistered {
                    ShotAnalysisView(session: authSession)
                } else {
                    RegistrationView { session in
                        withAnimation {
                            authSession = session
                            isRegistered = true
                        }
                    }
                }
            }
        }
    }
}
