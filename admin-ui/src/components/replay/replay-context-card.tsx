import { useTranslation } from "react-i18next"

import type { OutboundBlob } from "@/lib/admin-api"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table"

const EMPTY = "—"

type ReplayContextCardProps = {
  blob: OutboundBlob
}

function StatusBadge({ status }: { status: number }): React.JSX.Element {
  return status >= 400 ? (
    <Badge variant="destructive">{status}</Badge>
  ) : (
    <Badge variant="secondary">{status}</Badge>
  )
}

export function ReplayContextCard({
  blob,
}: ReplayContextCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("replayPage.contextTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="w-40 text-muted-foreground">
                request_id
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-words">
                {blob.request_id}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">path</TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-words">
                {blob.original?.path || EMPTY}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">
                upstream_endpoint
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-words">
                {blob.original?.upstream_endpoint || EMPTY}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">
                upstream_model
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-words">
                {blob.original?.upstream_model || EMPTY}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">client_model</TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-words">
                {blob.original?.client_model || EMPTY}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-muted-foreground">
                response_status
              </TableCell>
              <TableCell>
                <StatusBadge status={blob.response_status} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
