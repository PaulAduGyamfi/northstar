"use client";

import { useRouter } from "next/navigation";
import { apiFetch } from "../src/client-fetch";

// Ends the session at the API (which clears the cookie), then goes to sign-in.
export function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await apiFetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    router.replace("/sign-in");
  }
  return (
    <button type="button" className="secondary" onClick={signOut}>
      Sign out
    </button>
  );
}
