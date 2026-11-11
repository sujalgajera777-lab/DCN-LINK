'use strict';
// Same code runs on BOTH PCs. HUB alone owns PostgreSQL; PEER forwards real radio receipts.
// Both local websites can send and view the shared inbox.
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { SerialPort, ReadlineParser } = require('serialport');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SENDER = /^[A-Za-z0-9_-]{1,32}$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const BYTES = 160;

function matches(value, expected) {
  if (typeof value !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function isValidMessage({sender_id, message} = {}) {
  return typeof sender_id === 'string' && SENDER.test(sender_id) &&
    typeof message === 'string' && !!message.trim() &&
    !message.includes('\0') && Buffer.byteLength(message,'utf8') <= BYTES;
}
function receivedFrame(d) {
  if (!d || d.type !== 'received' || !UUID.test(d.id || '')) return null;
  const v = { id:d.id, sender_id:d.sender_id, message:d.text,
    from_mac:d.from_mac, rssi_dbm:d.rssi_dbm,
    uptime_ms:d.uptime_ms };
  if (!isValidMessage(v) || !MAC.test(v.from_mac || '')) return null;
  if (v.rssi_dbm != null && (!Number.isInteger(v.rssi_dbm) || v.rssi_dbm < -127 || v.rssi_dbm > 0)) return null;
  if (v.uptime_ms != null && (!Number.isSafeInteger(v.uptime_ms) || v.uptime_ms < 0)) return null;
  return v;
}

module.exports = function setupHardware({app, pool, mode, nodeId}) {
  const hub = mode === 'HUB';
  const hubUrl = (process.env.HUB_URL || '').replace(/\/+$/,'');
  const secret = process.env.GATEWAY_KEY;
  const spoolDir = process.env.DCN_SPOOL_DIR || path.join(__dirname, 'spool');
  const portName = process.env.ESP_PORT || 'COM5';
  const serial = new SerialPort({path:portName, baudRate:115200, autoOpen:false});
  const parser = serial.pipe(new ReadlineParser({delimiter:'\n'}));
  let ready = false;
  let mac = null;
  let opening = false;
  let draining = false;
  let sendQueue = Promise.resolve();

  async function openPort() {
    if (serial.isOpen || opening) return;
    opening = true;
    serial.open(error => {
      opening = false;
      if (error) console.warn(`[${nodeId}] ${portName}: ${error.message} (will retry)`);
    });
  }
  serial.on('open', () => {
    ready = false;
    console.log(`[${nodeId}] ESP32 serial opened on ${portName}`);
    serial.set({dtr:false,rts:false},error=>{
      if (error) console.warn(`[${nodeId}] DTR/RTS warning: ${error.message}`);
    });
    // ESP32 may have printed READY before COM was opened; request it again.
    serial.write('{"type":"ping"}\n');
  });
  serial.on('close', () => {ready=false;console.warn(`[${nodeId}] ESP32 disconnected`);});
  serial.on('error',error => {ready=false;console.warn(`[${nodeId}] Serial error: ${error.message}`);});
  setInterval(()=>{ if (!serial.isOpen) void openPort(); },3000).unref();
  setInterval(()=>{ if (serial.isOpen && !ready) serial.write('{"type":"ping"}\n'); },2000).unref();
  void openPort();

  function forwardHeaders() {
    return { 'Content-Type':'application/json', 'x-gateway-key': secret };
  }
  async function hubRequest(route, options={}) {
    const response = await fetch(hubUrl+route, {
      ...options,
      headers:{...forwardHeaders(),...(options.headers || {})},
      signal:AbortSignal.timeout(2500)
    });
    const body = await response.json().catch(()=>({}));
    return {status:response.status,ok:response.ok,body};
  }

  async function storeInDatabase(v, receivingNode) {
    // This code is only executed on the hub, never on the other PC.
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const claim=await client.query(
        'INSERT INTO hardware_receipts(packet_id) VALUES($1::uuid) ON CONFLICT DO NOTHING RETURNING packet_id',
        [v.id]);
      let row;
      if (claim.rowCount) {
        const metadata={
          packet_id:v.id, source:'dcn_link_bidirectional', hardware_link:'esp_now',
          radio_receiver_node:receivingNode, from_mac:v.from_mac,
          receiver_rssi_dbm:v.rssi_dbm ?? null,
          receiver_uptime_ms:v.uptime_ms ?? null,
          database_location:'HUB_PC', received_via:'esp32_usb'
        };
        const inserted=await client.query(
          `INSERT INTO text_messages(sender_id,receiver_id,message,transport,payload_bytes,metadata)
           VALUES($1,$2,$3,'esp_now',$4,$5::jsonb)
           RETURNING id,sender_id,receiver_id,message,transport,payload_bytes,metadata,received_at`,
          [v.sender_id,receivingNode,v.message,Buffer.byteLength(v.message,'utf8'),JSON.stringify(metadata)]);
        row=inserted.rows[0];
        await client.query('UPDATE hardware_receipts SET message_id=$2 WHERE packet_id=$1::uuid',[v.id,row.id]);
        console.log(`[${nodeId}] STORED from ESP-NOW on ${receivingNode}: message #${row.id}`);
      } else {
        const found=await client.query(
          `SELECT t.id,t.sender_id,t.receiver_id,t.message,t.transport,t.payload_bytes,t.metadata,t.received_at
           FROM hardware_receipts h JOIN text_messages t ON t.id=h.message_id WHERE h.packet_id=$1::uuid`,[v.id]);
        if (!found.rowCount) throw new Error('Duplicate packet exists without a message');
        row=found.rows[0];
      }
      await client.query('COMMIT');
      return row;
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally {client.release();}
  }

  async function saveOrForward(packet) {
    if (hub) return storeInDatabase(packet, nodeId);
    const result=await hubRequest('/api/hardware/ingest',{
      method:'POST', body:JSON.stringify({...packet, receiving_node:nodeId})
    });
    if (!result.ok) throw new Error(`Hub rejected received packet: ${result.status} ${result.body.error||''}`);
    return result.body.data;
  }
  async function queueReceived(d) {
    const packet=receivedFrame(d);
    if (!packet) return;
    // Durable file queue: packets survive application restarts / temporary LAN outages.
    await fs.mkdir(spoolDir,{recursive:true});
    const filename=path.join(spoolDir,packet.id+'.json');
    try { await fs.writeFile(filename,JSON.stringify(packet),'utf8'); }
    catch(error) {console.error(`[${nodeId}] Failed to spool radio receipt:`,error.message);return;}
    console.log(`[${nodeId}] ESP-NOW RECEIVED: ${packet.sender_id}: ${packet.message}`);
    void flushSpool();
  }
  async function flushSpool() {
    if (draining) return;
    draining=true;
    try {
      await fs.mkdir(spoolDir,{recursive:true});
      const files=(await fs.readdir(spoolDir)).filter(f=>UUID.test(f.replace(/\.json$/i,'')) && f.endsWith('.json')).sort();
      for (const f of files) {
        const name=path.join(spoolDir,f);
        try {
          const packet=JSON.parse(await fs.readFile(name,'utf8'));
          if (!receivedFrame({type:'received', id:packet.id, sender_id:packet.sender_id, text:packet.message,
                                 from_mac:packet.from_mac, rssi_dbm:packet.rssi_dbm, uptime_ms:packet.uptime_ms})) {
            console.error(`[${nodeId}] Invalid spool entry (kept for inspection): ${name}`);
            continue;
          }
          await saveOrForward(packet);
          await fs.unlink(name);
        } catch(error) {
          console.warn(`[${nodeId}] Receipt queued for retry: ${error.message}`);
          break; // Hub unreachable; retry when the network recovers.
        }
      }
    } catch(error) {console.error(`[${nodeId}] Spool failure:`,error.message);}
    finally {draining=false;}
  }
  setInterval(()=>{void flushSpool();},2500).unref();
  void flushSpool();

  parser.on('data',line=>{
    let d;
    try {d=JSON.parse(line.trim());} catch {return;}
    if (d.type === 'ready' && d.device_id === 'ESP32_NODE') {
      if (!ready) console.log(`[${nodeId}] ESP32 READY — MAC ${d.mac}`);
      ready=true; mac=d.mac;
    } else if (d.type === 'received') {
      void queueReceived(d);
    } else if (d.type === 'radio_ack') {
      console.log(`[${nodeId}] Radio ACK for ${d.id}`);
    } else if (d.type === 'error' || d.type === 'radio_error') {
      console.warn(`[${nodeId}] Firmware reported: ${d.message || d.status}`);
    }
  });

  async function lookup(id) {
    if (!UUID.test(id)) return null;
    if (hub) {
      const result=await pool.query(
        `SELECT t.id,t.sender_id,t.receiver_id,t.message,t.transport,t.payload_bytes,t.metadata,t.received_at
         FROM hardware_receipts h JOIN text_messages t ON t.id=h.message_id WHERE h.packet_id=$1::uuid`,[id]);
      return result.rows[0] || null;
    }
    const response=await hubRequest('/api/hardware/receipt/'+encodeURIComponent(id));
    if (response.status===404) return null;
    if (!response.ok) throw new Error('Hub receipt lookup failed: '+response.status);
    return response.body.data;
  }

  // Authenticated hub routes. The browser never receives the gateway key.
  if (hub) {
    app.post('/api/hardware/ingest',async(req,res)=>{
      if (!matches(req.get('x-gateway-key'),secret)) return res.status(401).json({success:false,error:'Unauthorized'});
      const {id,sender_id,message,from_mac,rssi_dbm,uptime_ms,receiving_node}=req.body || {};
      const normalized=receivedFrame({type:'received',id,sender_id,text:message,from_mac,rssi_dbm,uptime_ms});
      if (!normalized || typeof receiving_node!=='string' || !/^[A-Za-z0-9_-]{1,24}$/.test(receiving_node))
        return res.status(400).json({success:false,error:'Invalid received packet'});
      try {return res.status(201).json({success:true,data:await storeInDatabase(normalized,receiving_node)});}
      catch(error){console.error('[Hub] Ingest error:',error.message);return res.status(500).json({success:false,error:'Could not store packet'});}
    });
    app.get('/api/hardware/receipt/:id',async(req,res)=>{
      if (!matches(req.get('x-gateway-key'),secret)) return res.status(401).json({success:false,error:'Unauthorized'});
      try {const row=await lookup(req.params.id);return row?res.json({success:true,data:row}):res.status(404).json({success:false,saved:false});}
      catch(error){console.error('[Hub] Lookup:',error.message);return res.status(500).json({success:false,error:'Lookup failed'});}
    });
    app.get('/api/hardware/central-inbox',async(req,res)=>{
      if (!matches(req.get('x-gateway-key'),secret)) return res.status(401).json({success:false,error:'Unauthorized'});
      try {const rows=await getInbox();return res.json({success:true,messages:rows});}
      catch(error){console.error('[Hub] Inbox:',error.message);return res.status(500).json({success:false,error:'Inbox failed'});}
    });
  }

  async function getInbox(){
    if (!hub) throw new Error('Inbox is hosted by the HUB');
    const rows=await pool.query(
      `SELECT id,sender_id,receiver_id,message,transport,payload_bytes,metadata,received_at
       FROM text_messages WHERE transport='esp_now' AND metadata->>'source'='dcn_link_bidirectional'
       ORDER BY id DESC LIMIT 50`);
    return rows.rows;
  }
  app.get('/api/hardware/inbox',async(req,res)=>{
    if (!matches(req.get('x-view-code'),process.env.MESSAGE_VIEW_CODE))
      return res.status(401).json({success:false,error:'Invalid inbox code'});
    try {
      if (hub) return res.json({success:true,messages:await getInbox()});
      const result=await hubRequest('/api/hardware/central-inbox');
      if (!result.ok) throw new Error('Central inbox unavailable: '+result.status);
      return res.json(result.body);
    } catch(error) {return res.status(503).json({success:false,error:'Central inbox unavailable'});}
  });

  app.get('/health',async(_req,res)=>{
    if (!hub) return res.json({status:'ok',node_id:nodeId,mode,database:'central_on_hub',radio_ready:ready});
    try {await pool.query('SELECT 1');return res.json({status:'ok',node_id:nodeId,mode,database:'connected',radio_ready:ready});}
    catch {return res.status(503).json({status:'error',mode,database:'disconnected'});}
  });
  app.get('/api/hardware/status',async(_req,res)=>{
    let hubReachable=hub;
    if (!hub) {
      try {const r=await fetch(hubUrl+'/health',{signal:AbortSignal.timeout(1600)});
        const d=await r.json();hubReachable=r.ok && d.database==='connected';}
      catch {hubReachable=false;}
    }
    res.set('Cache-Control','no-store');
    res.json({success:true,mode,node_id:nodeId,radio_ready:ready,radio_mac:mac,
      esp_port:portName,central_database_online:hubReachable,max_text_bytes:BYTES});
  });

  async function transmit(frame) {
    if (!serial.isOpen || !ready) throw new Error('Local ESP32 not ready; verify COM port and firmware');
    const start=performance.now();
    for(let attempt=1;attempt<=4;attempt++) {
      if (!serial.isOpen || !ready) throw new Error('ESP32 disconnected during transmission');
      await new Promise((resolve,reject)=>{
        serial.write(JSON.stringify(frame)+'\n',error=>error?reject(error):resolve());
      });
      // Receiver stores only packets that physically arrived through the other board.
      const deadline=Date.now()+3000;
      while(Date.now()<deadline) {
        const row=await lookup(frame.id).catch(e=>{console.warn(`[${nodeId}] Hub lookup:`,e.message);return null;});
        if (row) return {...row, end_to_end_ms:Math.round(performance.now()-start)};
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      console.warn(`[${nodeId}] No stored receipt yet, radio attempt ${attempt}/4`);
    }
    // Final check: storage may have raced with the last timeout.
    const last=await lookup(frame.id).catch(()=>null);
    if(last) return {...last,end_to_end_ms:Math.round(performance.now()-start)};
    throw new Error('No confirmed database receipt after retries. Message may still arrive later; check inbox before resending.');
  }
  app.post('/api/hardware/send',async(req,res)=>{
    if (!matches(req.get('x-send-code'),process.env.MESSAGE_SEND_CODE))
      return res.status(401).json({success:false,error:'Invalid sender code'});
    const {sender_id,message}=req.body || {};
    if (!isValidMessage({sender_id,message}))
      return res.status(400).json({success:false,error:'Use a sender name of 1–32 characters and text up to 160 UTF-8 bytes'});
    if (!serial.isOpen || !ready) return res.status(503).json({success:false,error:'Local ESP32 is not ready'});
    const frame={type:'deliver',id:randomUUID(),sender_id,text:message};
    const task=sendQueue.then(()=>transmit(frame));
    sendQueue=task.catch(()=>{});
    try {const data=await task;return res.status(201).json({success:true,data});}
    catch(error){console.error(`[${nodeId}] Send failed:`,error.message);return res.status(504).json({success:false,error:error.message});}
  });
};
