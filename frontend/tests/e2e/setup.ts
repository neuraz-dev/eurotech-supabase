import { mkdir, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
export default async function setup() {
  const url = process.env.MONITOR_TEST_SUPABASE_URL
  if (url !== 'http://127.0.0.1:55421')
    throw new Error('E2E only runs against the isolated local stack')
  const admin = createClient(url, process.env.MONITOR_TEST_SECRET_KEY!, {
    auth: { persistSession: false },
  })
  const { data: guard, error: guardError } = await admin
    .schema('ml')
    .from('monitor_local_fixture_guard')
    .select('id')
    .single()
  if (guardError || guard?.id !== 'eurotech-monitor-improvements')
    throw new Error(
      'No se encontró la marca de fixtures sintéticas; se cancelan las pruebas',
    )
  const email = 'monitor.local@example.test',
    password = 'Monitor-local-test-2026!'
  const { data: users, error } = await admin.auth.admin.listUsers()
  if (error) throw error
  if (!users.users.some((user) => user.email === email)) {
    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error) throw error
  }
  const cookies: { name: string; value: string }[] = []
  const client = createServerClient(
    url,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: (values) => {
          for (const cookie of values)
            cookies.push({ name: cookie.name, value: cookie.value })
        },
      },
    },
  )
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  })
  if (signInError) throw signInError
  await mkdir('.test-auth', { recursive: true })
  await writeFile(
    '.test-auth/monitor.json',
    JSON.stringify({
      cookies: cookies.map((cookie) => ({
        ...cookie,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
        expires: -1,
      })),
      origins: [],
    }),
  )
}
