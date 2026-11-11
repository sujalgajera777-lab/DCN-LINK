'use strict';
// Offline software simulation: two fake serial ESP32s + fake hub Postgres.
// No real radio, Windows COM port, HTTP or database is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
const radios=[];
class FakeReadlineParser extends EventEmitter {}
class FakeSerialPort extends EventEmitter {
  constructor({path:port}) {super();this.path=port;this.isOpen=false;this.parser=null;radios.push(this);}
  pipe(parser){this.parser=parser;return parser;}
  open(cb){this.isOpen=true; queueMicrotask(()=>{this.emit('open');cb?.(null);});}
  set(_obj,cb){cb?.(null);}
  write(text,cb){
    let d;try{d=JSON.parse(text);}catch {cb?.(new Error('bad serial JSON'));return;}
    cb?.(null);
    if(d.type==='ping'){
      queueMicrotask(()=>this.parser.emit('data',JSON.stringify({type:'ready',device_id:'ESP32_NODE',mac:this.path==='COMA'?'30:76:F5:05:44:68':'20:00:00:00:00:02'})));
    }
    if(d.type==='deliver'){
      const other=radios.find(r=>r!==this);
      if(!other) return;
      queueMicrotask(()=>{
        other.parser.emit('data',JSON.stringify({type:'received',id:d.id,sender_id:d.sender_id,text:d.text,
          from_mac:'30:76:F5:05:44:68',rssi_dbm:-60,uptime_ms:1234}));
        this.parser.emit('data',JSON.stringify({type:'radio_ack',id:d.id}));
      });
    }
  }
}
Module._load=function(request,parent,isMain){
  if(request==='serialport') return {SerialPort:FakeSerialPort,ReadlineParser:FakeReadlineParser};
  return originalLoad.apply(this,arguments);
};
const setup=require('../hardware-messages');
Module._load=originalLoad;

class FakeApp {
 constructor(){this.routes=[];}
 get(path,fn){this.routes.push(['GET',path,fn]);}
 post(path,fn){this.routes.push(['POST',path,fn]);}
 async call(method,requestPath,{headers={},body={}}={}){
  const route=this.routes.find(r=>r[0]===method &&
    (r[1]===requestPath || r[1].includes(':id') && requestPath.startsWith(r[1].split(':id')[0])));
  assert.ok(route,`Route not found: ${method} ${requestPath}`);
  const req={body,params:{id:requestPath.split('/').at(-1)},get:k=>headers[k.toLowerCase()]};
  return await new Promise((resolve,reject)=>{
    let status=200,done=false;
    const res={set(){return res;},status(n){status=n;return res;},json(data){done=true;resolve({status,ok:status>=200&&status<300,data});return res;}};
    try {Promise.resolve(route[2](req,res)).catch(reject);}catch(e){reject(e);}
  });
 }
}
const receipts=new Map();const rows=[];
let nextId=1;
const fakeClient={
 async query(sql,args=[]){
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
  if(sql.startsWith('INSERT INTO hardware_receipts')){
   if(receipts.has(args[0]))return {rowCount:0,rows:[]};
   receipts.set(args[0],null);return {rowCount:1,rows:[{packet_id:args[0]}]};
  }
  if(sql.includes('INSERT INTO text_messages')){
   const [sender_id,receiver_id,message,payload_bytes,metadata]=args;
   const row={id:nextId++,sender_id,receiver_id,message,transport:'esp_now',payload_bytes,metadata:JSON.parse(metadata),received_at:new Date().toISOString()};
   rows.push(row);return {rowCount:1,rows:[row]};
  }
  if(sql.startsWith('UPDATE hardware_receipts')){
   receipts.set(args[0],args[1]);return {rowCount:1,rows:[]};
  }
  if(sql.includes('JOIN text_messages')){
   const row=rows.find(r=>r.id===receipts.get(args[0]));
   return {rowCount:row?1:0,rows:row?[row]:[]};
  }
  throw new Error('Fake client unsupported SQL: '+sql);
 },release(){}
};
const pool={async connect(){return fakeClient;},async query(sql,args=[]){
 if(sql==='SELECT 1')return {rowCount:1,rows:[{x:1}]};
 if(sql.includes('JOIN text_messages'))return fakeClient.query(sql,args);
 if(sql.includes('FROM text_messages WHERE transport'))return {rowCount:rows.length,rows:[...rows].reverse()};
 throw new Error('Fake pool unsupported SQL: '+sql);
}};

(async()=>{
 const spoolPath=await fs.mkdtemp(path.join(os.tmpdir(),'dcn-simulation-'));
 process.env.DCN_SPOOL_DIR=spoolPath;
 process.env.ESP_PORT='COMA';
 process.env.GATEWAY_KEY='test-prototype-gateway-key-is-long';
 process.env.MESSAGE_SEND_CODE='sample-sender-code';
 process.env.MESSAGE_VIEW_CODE='sample-view-code';
 const hub=new FakeApp();
 setup({app:hub,pool,mode:'HUB',nodeId:'NODE_A'});
 process.env.ESP_PORT='COMB';
 process.env.HUB_URL='http://hub:3000';
 const peer=new FakeApp();
 setup({app:peer,pool:null,mode:'PEER',nodeId:'NODE_B'});
 // Fake HTTP LAN calls from PEER to HUB.
 global.fetch=async(url,opts={})=>{
  const u=new URL(url);
  assert.equal(u.host,'hub:3000');
  const res=await hub.call(opts.method||'GET',u.pathname,{headers:opts.headers||{},body:opts.body?JSON.parse(opts.body):{}});
  return {ok:res.ok,status:res.status,json:async()=>res.data};
 };
 // Allow fake serial open + READY events to fire.
 await new Promise(resolve=>setTimeout(resolve,30));
 async function send(app,name,message){
  const result=await app.call('POST','/api/hardware/send',{
   headers:{'x-send-code':'sample-sender-code'},body:{sender_id:name,message}
  });
  assert.equal(result.status,201,JSON.stringify(result));
  return result.data.data;
 }
 const a=await send(hub,'Alice','Hello from central PC!');
 assert.equal(a.receiver_id,'NODE_B');
 const b=await send(peer,'Bob','Reply from other PC!');
 assert.equal(b.receiver_id,'NODE_A');
 assert.equal(rows.length,2);
 const inbox=await peer.call('GET','/api/hardware/inbox',{headers:{'x-view-code':'sample-view-code'}});
 assert.equal(inbox.status,200);
 assert.equal(inbox.data.messages.length,2);
 assert.equal(inbox.data.messages[0].message,'Reply from other PC!');
 // Replaying an already stored packet cannot insert a duplicate DB row.
 radios[1].parser.emit('data',JSON.stringify({type:'received',id:a.metadata.packet_id,sender_id:'Alice',text:a.message,
   from_mac:'30:76:F5:05:44:68',rssi_dbm:-60,uptime_ms:1234}));
 await new Promise(resolve=>setTimeout(resolve,120));
 assert.equal(rows.length,2);
 await fs.rm(spoolPath,{recursive:true,force:true});
 console.log('PASS: simulated A→B, B→A, central DB storage, peer inbox, duplicate protection');
})().catch(e=>{console.error(e);process.exitCode=1;});
