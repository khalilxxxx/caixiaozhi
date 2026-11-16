import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const out = 'artifacts/agno-local-20261116';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors=[];
page.on('pageerror', e=>errors.push(String(e)));
page.on('console', m=> {if(m.type()==='error') errors.push(m.text());});
const results=[];
for(const route of ['home','documents','submission','rules','analysis','skills','knowledge','files','history']) {
 const ready=page.waitForResponse(r=>r.url().endsWith('/api/local/workspace') && r.status()===200,{timeout:10000});
 await page.goto('http://127.0.0.1:5190/agent.html?qa='+route+'#'+route);
 await ready;
 await page.locator('.runtime-status').waitFor({state:'visible',timeout:3000}).catch(()=>{});
 await page.waitForTimeout(350);
 results.push({route,title:await page.title(),text:(await page.locator('body').innerText()).slice(0,1800)});
 await page.screenshot({path:`${out}/desktop-${route}.png`,fullPage:true});
}
await page.setViewportSize({width:390,height:844});
await page.goto('http://127.0.0.1:5190/agent.html#home');
await page.waitForTimeout(800);
await page.screenshot({path:`${out}/mobile-home.png`,fullPage:true});
await fs.writeFile(`${out}/browser-pages.json`,JSON.stringify({errors,results},null,2));
console.log(JSON.stringify({errors,results:results.map(r=>({route:r.route,title:r.title,text:r.text.slice(0,600)}))},null,2));
await browser.close();
if(errors.length)process.exit(1);
