import {mkdir,writeFile} from 'node:fs/promises'
import {createServerClient} from '@supabase/ssr'
export default async function auth(){
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL
  if(url!=='http://127.0.0.1:55421')throw new Error('Solo se permite Monitor local')
  const cookies:{name:string;value:string}[]=[]
  const client=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,{
    cookies:{getAll:()=>[],setAll:values=>{for(const value of values)cookies.push({name:value.name,value:value.value})}},
  })
  const {error}=await client.auth.signInWithPassword({email:'monitor.local@example.test',password:'Monitor-local-test-2026!'})
  if(error)throw error
  await mkdir('.test-auth',{recursive:true})
  await writeFile('.test-auth/monitor-events.json',JSON.stringify({cookies:cookies.map(cookie=>({...cookie,domain:'127.0.0.1',path:'/',httpOnly:false,secure:false,sameSite:'Lax',expires:-1})),origins:[]}),{mode:0o600})
}
