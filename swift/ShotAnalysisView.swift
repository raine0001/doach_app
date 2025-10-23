import SwiftUI

struct ShotAnalysisView: View {
    var session: AuthSession?

    var body: some View {
        WebAppView(url: AppConfig.shotAnalysisURL, session: session)
            .ignoresSafeArea()
    }
}

struct ShotAnalysisView_Previews: PreviewProvider {
    static var previews: some View {
        ShotAnalysisView(session: nil)
    }
}
