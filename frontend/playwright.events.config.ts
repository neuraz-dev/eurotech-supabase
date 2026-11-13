import {defineConfig} from '@playwright/test'
export default defineConfig({
  testDir:'./tests/event-ui',workers:1,fullyParallel:false,retries:0,
  globalSetup:'./tests/event-ui/auth.ts',
  use:{baseURL:'http://127.0.0.1:3000',storageState:'.test-auth/monitor-events.json',timezoneId:'America/Bogota',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{browserName:'chromium'}}],
  webServer:{command:'npm run start -- --hostname 127.0.0.1 --port 3000',url:'http://127.0.0.1:3000/login',reuseExistingServer:true,timeout:120000},
})
