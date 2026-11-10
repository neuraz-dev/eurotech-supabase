import { invokeMonitor, withMonitorAuth } from '@/lib/monitoring/server'
export const POST = withMonitorAuth(async () =>
  invokeMonitor('ml-scrape-tracked'),
)
