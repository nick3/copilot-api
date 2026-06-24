import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { AccountsPage } from "@/pages/accounts-page"
import { ModelsPage } from "@/pages/models-page"
import { NotFoundPage } from "@/pages/not-found-page"
import { RequestDetailPage } from "@/pages/request-detail-page"
import { RequestReplayPage } from "@/pages/request-replay-page"
import { RequestsPage } from "@/pages/requests-page"
import { SettingsPage } from "@/pages/settings-page"
import { StatisticsPage } from "@/pages/statistics-page"
import { TokenUsagePage } from "@/pages/token-usage-page"

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/accounts" replace />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/statistics" element={<StatisticsPage />} />
        <Route path="/token-usage" element={<TokenUsagePage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/request/:requestId" element={<RequestDetailPage />} />
        <Route path="/requests/:requestId/replay" element={<RequestReplayPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
