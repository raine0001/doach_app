import Foundation

struct AuthSession {
    let cookies: [HTTPCookie]
    let responseHeaders: [String: String]
    let responseBody: Data

    var accessToken: String? {
        guard
            let object = try? JSONSerialization.jsonObject(with: responseBody),
            let json = object as? [String: Any]
        else { return nil }
        for key in ["access_token", "accessToken", "token"] {
            if let token = json[key] as? String {
                return token
            }
        }
        return nil
    }

    func headerValue(forCaseInsensitiveKey key: String) -> String? {
        responseHeaders.first { $0.key.caseInsensitiveCompare(key) == .orderedSame }?.value
    }

    var signature: String {
        let cookieSignature = cookies
            .map { "\($0.name)=\($0.value)" }
            .sorted()
            .joined(separator: ";")
        return [cookieSignature, accessToken ?? ""].joined(separator: "|")
    }
}
