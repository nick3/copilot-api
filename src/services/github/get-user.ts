import type { AccountContext } from "~/lib/types/account"

import consola from "consola"
import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { accountFromState, state } from "~/lib/state"

const resolveGitHubUserAccount = (account?: AccountContext): AccountContext => {
  if (account) {
    return account
  }

  if (!state.githubToken) {
    throw new Error("GitHub token not set")
  }

  return accountFromState()
}

export async function getGitHubUser(account?: AccountContext) {
  const resolvedAccount = resolveGitHubUserAccount(account)

  const response = await fetch(`${getGitHubApiBaseUrl()}/user`, {
    headers: githubUserHeaders(resolvedAccount),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error(
      "Failed to get GitHub user response body",
      errorText.slice(0, 4_000),
    )

    throw new HTTPError("Failed to get GitHub user", response)
  }

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
export interface GithubUserResponse {
  login: string
}
