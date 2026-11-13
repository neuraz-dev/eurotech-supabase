import {NextRequest,NextResponse} from 'next/server'
import {createAdminClient} from '@/lib/supabase/admin'
import {ApiError,mlContext,readBody,withMonitorAuth} from '@/lib/monitoring/server'
import {alertActor} from '@/lib/alert-server'
import {recoverFixedTarget} from '@monitoring/source-recovery'
import {fetchFx} from '@monitoring/ml-observation'
export const GET=withMonitorAuth(async(req:NextRequest)=>{
 const sku=req.nextUrl.searchParams.get('sku')?.trim().toLowerCase()
 if(!sku||sku.length>255)throw new ApiError(400,'SKU inválido')
 const {data,error}=await createAdminClient().schema('ml').from('ml_monitor_repairs').select('key,sku,status,candidates,last_error,evidence,expected_seller_id,catalog_id').eq('sku',sku).eq('kind','recover_fixed').limit(100)
 if(error)throw error
 return NextResponse.json({items:data})
})
export const POST=withMonitorAuth(async(req:NextRequest)=>{
 const body=await readBody(req)
 if(typeof body.key!=='string'||body.key.length>200)throw new ApiError(400,'Recuperación inválida')
 if(body.itemId!==undefined&&(typeof body.itemId!=='string'||!/^ML[AU]\d+$/.test(body.itemId)))throw new ApiError(400,'MLU inválida')
 const admin=createAdminClient()
 const {data,error}=await admin.schema('ml').from('ml_monitor_repairs').select('*').eq('key',body.key).eq('kind','recover_fixed').maybeSingle()
 if(error)throw error
 if(!data)throw new ApiError(404,'No se encontró la recuperación')
 if(data.status==='resolved')return NextResponse.json({ok:true,resolved:true,item:data})
 try{
  const context=await mlContext(admin),fx=await fetchFx(fetch,process.env.MONITOR_FX_URL)
  const result=await recoverFixedTarget(admin,data,{...context,fx},body.itemId as string|undefined,await alertActor())
  return NextResponse.json({ok:true,...result})
 }catch(error){throw new ApiError(422,error instanceof Error?error.message:'No se pudo verificar la publicación original')}
})
