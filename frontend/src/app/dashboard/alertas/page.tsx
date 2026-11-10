import { createAdminClient } from '@/lib/supabase/admin'
import { loadAlertPage } from '@/lib/alert-server'
import AlertasLayout from './AlertasLayout'
import type { AlertPage, AlertOptions, AlertRule } from '@/lib/price-alerts'
export const dynamic='force-dynamic'
export default async function AlertasPage(){
  const admin=createAdminClient()
  let props:{initialPage:AlertPage;options:AlertOptions;rules:AlertRule[]}|null=null
  try{
    const [page,options,rules]=await Promise.all([
      loadAlertPage(),admin.schema('ml').rpc('monitor_alert_options'),
      admin.schema('ml').from('ml_price_alert_rules').select('*,ml_price_alerts(count)').order('created_at',{ascending:false}),
    ])
    if(options.error)throw options.error
    if(rules.error)throw rules.error
    const persistedRules=await Promise.all((rules.data as AlertRule[]).map(async rule=>{
      const result=await admin.schema('ml').from('ml_price_alerts').select('id',{count:'exact',head:true}).contains('matched_rules',JSON.stringify([{id:rule.id}]))
      if(result.error)throw result.error
      return {...rule,ml_price_alerts:[{count:result.count??0}] as [{count:number}]}
    }))
    props={initialPage:page,options:options.data,rules:persistedRules}
  }catch{ /* The visible error preserves the option to retry the request. */ }
  if(!props)return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">No se pudieron cargar las alertas. Recargá para reintentar.</div>
  return <AlertasLayout {...props}/>
}
