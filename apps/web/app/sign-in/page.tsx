import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main className="page">
      <div className="card">
        <h1>Sign in to Northstar</h1>
        <p className="muted">
          Use a passkey you added, or paste your sign-in key. The key is checked by the API and
          never stored.
        </p>
        <SignInForm />
      </div>
    </main>
  );
}
