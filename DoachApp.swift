import SwiftUI

@main
struct DoachApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView(urlString: "https://www.doach.app")
                .ignoresSafeArea()
        }
    }
}
