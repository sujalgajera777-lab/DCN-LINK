"use strict";
require("dotenv").config();
const express = require("express");
const path = require("node:path");
const { Pool } = require("pg");
const setupHardware = require("./hardware-messages");

const mode = String(process.env.MODE || "").trim().toUpperCase();
if (!['HUB', 'PEER'].includes(mode)) throw new Error('MODE must be HUB or PEER in .env');
const nodeId = process.env.NODE_ID || '';
if (!/^[A-Za-z0-9_-]{1,24}$/.test(nodeId)) throw new Error('Set NODE_ID in .env (e.g. NODE_A / NODE_B)');
if (!process.env.GATEWAY_KEY || process.env.GATEWAY_KEY.length < 20 ||
    !process.env.MESSAGE_SEND_CODE || !process.env.MESSAGE_VIEW_CODE ||
    [process.env.GATEWAY_KEY, process.env.MESSAGE_SEND_CODE, process.env.MESSAGE_VIEW_CODE]
       .some(s => /^CHANGE_ME/i.test(s))) {
  throw new Error('Set non-placeholder GATEWAY_KEY (20+ chars), MESSAGE_SEND_CODE and MESSAGE_VIEW_CODE in .env');
}
if (mode === 'PEER' && !/^http:\/\/[^/]+:\d+$/.test(process.env.HUB_URL || '')) {
  throw new Error('PEER requires HUB_URL=http://YOUR_PC_WIFI_IP:3000');
}
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'8kb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req,res) => res.redirect('/abc.html'));

const pool = mode === 'HUB' ? new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5000),
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000
}) : null;

setupHardware({app,pool,mode,nodeId});

app.use((error,_req,res,_next)=>{
  console.error('[HTTP]',error.message);
  res.status(error.status || 500).json({success:false,error:'Request could not be processed'});
});
const PORT=Number(process.env.PORT || 3000);
async function start(){
  if (pool) {
    await pool.query('SELECT 1');
    // Check that SQL setup has already been run.
    await pool.query('SELECT packet_id FROM hardware_receipts LIMIT 0');
    console.log('[Database] PostgreSQL connected; hardware_receipts ready');
  }
  app.listen(PORT,'0.0.0.0',()=>{
    console.log(`[DCN·LINK] ${mode} NODE_ID=${nodeId} listening on port ${PORT}`);
    console.log(`[DCN·LINK] http://localhost:${PORT}/sender.html`);
    console.log(`[DCN·LINK] http://localhost:${PORT}/receiver.html`);
    console.log(`[DCN·LINK] Serial ESP32: ${process.env.ESP_PORT || 'COM5'}`);
    if (mode==='PEER') console.log(`[DCN·LINK] Central database server: ${process.env.HUB_URL}`);
  });
}
start().catch(error=>{console.error('[Startup]',error.message);process.exitCode=1;pool?.end();});
