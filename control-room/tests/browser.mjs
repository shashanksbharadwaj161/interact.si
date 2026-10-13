import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser=await chromium.launch({headless:true,channel:process.env.TEST_BROWSER || 'msedge'});const page=await browser.newPage({viewport:{width:1440,height:980}});
const taskName='Browser verification '+Date.now();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:4317');await page.getByText('Live connection',{exact:false}).waitFor();
 await page.getByRole('button',{name:'New task'}).click();await page.getByLabel('Task name',{exact:true}).fill(taskName);await page.getByLabel('Instructions',{exact:true}).fill('Demonstrate a simulated worker with clear activity and review.');await page.getByRole('button',{name:'Start simulation'}).click();
 await page.getByRole('dialog').getByText('Demo worker started in simulated workspace.').waitFor();await page.getByRole('button',{name:'Mark reviewed'}).waitFor({timeout:10000});
 await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.getByText('Draft result ready. No real files changed.').last().waitFor({timeout:10000});
 await page.getByRole('button',{name:'Mark reviewed'}).click();await page.getByRole('button',{name:'Task board',exact:false}).first().click();await page.getByRole('button',{name:'DEMO '+taskName,exact:false}).waitFor();
 await page.getByRole('button',{name:'Providers',exact:false}).first().click();await page.getByLabel('API key',{exact:true}).waitFor();assert.equal(await page.getByLabel('API key',{exact:true}).getAttribute('type'),'password');
 await page.getByRole('button',{name:'Overview',exact:false}).first().click();await page.screenshot({path:path.resolve('preview-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.resolve('preview-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 assert.deepEqual(errors,[]);console.log('Browser checks passed: simulation, review, navigation, masked key field, responsive layout, no page errors.');
}catch(e){await page.screenshot({path:path.resolve('browser-error.png'),fullPage:true});console.error('Page errors:',errors);console.error((await page.locator('body').innerText()).slice(0,1800));throw e;}finally{await browser.close();}



