import SyncHistory from '../SyncHistory'
export default async function Page(
  { params }: { params: Promise<{ id: string }> },
) {
  return <SyncHistory id={(await params).id} />
}
