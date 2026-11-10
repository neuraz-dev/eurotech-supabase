'use client'
import { useRouter } from 'next/navigation'
import ManualSyncControl from '@/components/ManualSyncControl'
export default function SyncButton(){
  const router=useRouter()
  return <ManualSyncControl origin="productos-alertas" onComplete={()=>router.refresh()}/>
}
