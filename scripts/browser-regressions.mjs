import { createServer } from 'vite';
import { spawn } from 'node:child_process';
const server=await createServer({server:{host:'127.0.0.1',port:5195,strictPort:true}});await server.listen();
try {
  for(const script of ['browser-smoke.mjs','audio-smoke.mjs','tuning-smoke.mjs']) {
    const code=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[`scripts/${script}`],{env:{...process.env,BATTLE_URL:'http://127.0.0.1:5195/?flat=1'},stdio:'inherit',windowsHide:true});
      child.on('error',reject);child.on('exit',resolve);
    });
    if(code!==0)throw new Error(`${script} failed: ${code}`);
  }
} finally {await server.close();}
