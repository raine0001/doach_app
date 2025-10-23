import SwiftUI

struct RegistrationView: View {
    enum Field {
        case email
        case password
        case confirmPassword
    }

    @Environment(\.openURL) private var openURL
    @FocusState private var focusedField: Field?

    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    let onComplete: (AuthSession?) -> Void
    private let authClient = AuthClient()

    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Text("Welcome to Doach")
                            .font(.largeTitle)
                            .fontWeight(.bold)
                        Text("Create an account to sync your shot sessions across devices.")
                            .font(.body)
                            .multilineTextAlignment(.center)
                            .foregroundColor(.secondary)
                    }

                    VStack(spacing: 16) {
                        TextField("Email address", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .focused($focusedField, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .password }

                        SecureField("Password (min 8 characters)", text: $password)
                            .textContentType(.newPassword)
                            .focused($focusedField, equals: .password)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .confirmPassword }

                        SecureField("Confirm password", text: $confirmPassword)
                            .textContentType(.newPassword)
                            .focused($focusedField, equals: .confirmPassword)
                            .submitLabel(.go)
                            .onSubmit(submit)
                    }
                    .textFieldStyle(.roundedBorder)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: submit) {
                        HStack {
                            if isWorking {
                                ProgressView()
                            }
                            Text("Create account")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isWorking || !canSubmit)

                    Button("Already have an account? Sign in on the web") {
                        openURL(AppConfig.loginURL)
                    }

                    Button("Continue without creating an account") {
                        onComplete(nil)
                    }
                    .tint(.secondary)
                }
                .padding(24)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Get Started")
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focusedField = nil }
            }
        }
    }

    private var canSubmit: Bool {
        email.isValidEmail &&
        password.count >= 8 &&
        password == confirmPassword
    }

    private func submit() {
        guard !isWorking else { return }
        guard canSubmit else {
            if password != confirmPassword {
                errorMessage = "Passwords do not match."
            } else if password.count < 8 {
                errorMessage = "Password must be at least 8 characters."
            } else {
                errorMessage = "Enter a valid email address."
            }
            return
        }

        focusedField = nil
        errorMessage = nil
        isWorking = true

        let sanitizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let passwordValue = password

        Task {
            do {
                let session = try await authClient.register(email: sanitizedEmail, password: passwordValue)
                await MainActor.run {
                    isWorking = false
                    onComplete(session)
                }
            } catch {
                await MainActor.run {
                    isWorking = false
                    errorMessage = (error as? LocalizedError)?.errorDescription
                        ?? "Something went wrong. Try again."
                }
            }
        }
    }
}

private extension String {
    var isValidEmail: Bool {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard let atIndex = trimmed.firstIndex(of: "@"),
              trimmed[trimmed.startIndex] != "@",
              trimmed[trimmed.index(before: trimmed.endIndex)] != "@"
        else { return false }
        let domainPart = trimmed[trimmed.index(after: atIndex)...]
        return domainPart.contains(".")
    }
}

struct RegistrationView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            RegistrationView { _ in }
        }
    }
}
