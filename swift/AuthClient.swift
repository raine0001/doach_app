import Foundation

struct AuthClient {
    enum AuthError: Error {
        case invalidResponse
        case unsuccessful(status: Int, message: String)
    }

    func register(email: String, password: String) async throws -> AuthSession {
        let registerURL = AppConfig.apiBaseURL.appendingPathComponent(AppConfig.registrationPath)

        var request = URLRequest(url: registerURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RegisterPayload(email: email, password: password))

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AuthError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8)
                ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
            throw AuthError.unsuccessful(status: httpResponse.statusCode, message: message)
        }

        let headerFields = httpResponse.allHeaderFields.reduce(into: [String: String]()) { partial, pair in
            guard let key = pair.key as? String else { return }
            partial[key] = String(describing: pair.value)
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: AppConfig.apiBaseURL)

        return AuthSession(
            cookies: cookies,
            responseHeaders: headerFields,
            responseBody: data
        )
    }
}

extension AuthClient.AuthError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "We couldn't contact the server. Check your connection and try again."
        case .unsuccessful(let status, let message):
            return "Registration failed (\(status)). \(message)"
        }
    }
}

private struct RegisterPayload: Encodable {
    let email: String
    let password: String
}
