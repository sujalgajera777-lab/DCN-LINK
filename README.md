# DCN·LINK — One identical project on both PCs (bidirectional ESP-NOW)

**What's changed:** BOTH computers run the same `index.js`, `hardware-messages.js`, `public/` website, and the EXACT SAME `DCN_Transceiver.ino` firmware. Either computer can **send and receive** text through its ESP32. The only per-computer difference is its private `.env` configuration.

## 1. Architecture (IMPORTANT)

```
           YOUR PC (HUB)                         OTHER PC (PEER)
        D:\DCN-LINK\                           D:\DCN-LINK\
       sender.html + receiver.html            sender.html + receiver.html
             Node.js                              Node.js
               | USB                                | USB
             ESP32 <============= ESP-NOW =======> ESP32
               |                                     |
        PostgreSQL (central) <--- Wi-Fi LAN --- receiver Node.js forwards
```

**Both boards are transceivers**. The node whose board receives a radio packet forwards it to the central database. Your PC (HUB) stores ALL received messages in its existing PostgreSQL `iot_db` database, regardless of which direction the message travelled. The other PC (PEER) **does not** need PostgreSQL. Other PC -> your ESP32: your PC stores locally; your PC -> other ESP32: other PC forwards received text to your PC for storage over the shared Wi-Fi.

This uses a genuine **ESP-NOW radio hop**. It also uses local Wi-Fi **after receiving** for DB forwarding and confirmation. **Text only** (up to 160 UTF-8 bytes). Images, videos and arbitrary files are NOT yet implemented. ESP-NOW packets use unencrypted broadcast for demonstration — do not send private information; do not expose the HTTP ports to the public internet.

## 2. Extract and copy (same files on BOTH PCs)

On both PCs extract the ZIP completely and copy its contents to `D:\DCN-LINK\`. Do not open firmware directly from the ZIP.

```
D:\DCN-LINK\
├── index.js
├── hardware-messages.js
├── package.json
├── .env.example
├── .env                      <-- create separately on EACH PC
├── public\                   <-- same sender and receiver website
│   ├── sender.html
│   ├── receiver.html
│   ├── transmitter.js
│   ├── receiver.js
│   ├── abc.html
│   └── ... CSS / other pages
├── firmware\DCN_Transceiver\
│   ├── DCN_Transceiver.ino
│   └── DCNProtocol.h
└── sql\01_setup.sql
```

On **each PC** open CMD and run:

```cmd
cd /d D:\DCN-LINK
REM On YOUR PC (central PostgreSQL database):
copy config\YOUR_PC_HUB.env.example .env
REM On the OTHER PC instead:
REM copy config\OTHER_PC_PEER.env.example .env
notepad .env
```

### YOUR PC (the one with PostgreSQL) — HUB `.env`

```ini
MODE=HUB
NODE_ID=NODE_A
PORT=3000
ESP_PORT=COM5
MESSAGE_SEND_CODE=<your-private-send-code>
MESSAGE_VIEW_CODE=<your-private-view-code>
GATEWAY_KEY=<random-shared-secret-at-least-20-characters>
DB_HOST=127.0.0.1
DB_PORT=5000
DB_NAME=iot_db
DB_USER=iot_app
DB_PASSWORD=<your-existing-db-password>
```

`HUB_URL` is ignored on the HUB. Use your actual COM port.

### OTHER PC — PEER `.env`

```ini
MODE=PEER
NODE_ID=NODE_B
PORT=3000
ESP_PORT=COM5
HUB_URL=http://<YOUR_PC_WIFI_IPV4>:3000
MESSAGE_SEND_CODE=<SAME-private-send-code>
MESSAGE_VIEW_CODE=<SAME-private-view-code>
GATEWAY_KEY=<SAME-random-shared-secret-at-least-20-characters>
```

**The sender/view codes and gateway key must match on both PCs.** The peer can leave `DB_` settings unused. `NODE_ID` must differ; `ESP_PORT` is the local PC's actual port (e.g. COM5 / COM7); it can be COM5 on both PCs. Your old credentials were shared in a prior upload — rotate them for safety. Never share `.env` or add it to Git.

To find the COM port on each computer:

```cmd
cd /d D:\DCN-LINK
node -e "require('serialport').SerialPort.list().then(console.log)"
```

### Install dependencies (on BOTH PCs)

```cmd
cd /d D:\DCN-LINK
npm install
```

You may also use `INSTALL_WINDOWS.cmd` after creating `.env`, then `START_DCN_LINK.cmd` to run the backend. Both batch scripts are identical on both PCs.

Close all Arduino Serial Monitor windows before starting Node. `serialport` requires native bindings. If it doesn't load, ensure the `@serialport/bindings-cpp` installation script is permitted by your local npm setup.

## 3. Upload the SAME firmware to BOTH ESP32 boards

On **each PC**:

1. Open `D:\DCN-LINK\firmware\DCN_Transceiver\DCN_Transceiver.ino` in Arduino IDE **from the extracted folder**.
2. Keep `DCNProtocol.h` in the **same** `DCN_Transceiver` sketch directory.
3. Install Espressif Arduino ESP32 boards core **3.x** and **ArduinoJson 7.x** (Library Manager).
4. Choose your board (e.g., **ESP32 Dev Module**) and local COM port.
5. Upload; open Serial Monitor at **115200**, press EN/RESET, look for `{"type":"ready","device_id":"ESP32_NODE",...}`.
6. Close Serial Monitor before starting Node (both cannot own COM simultaneously).

Both boards use ESP-NOW channel **1**. No Wi-Fi SSID/password is needed on the boards; the PCs use Wi-Fi separately for forwarding receipts to your DB.

## 4. Database — only on YOUR PC (HUB)

Keep your existing PostgreSQL `iot_db`, existing messages and sensor tables. Run this SQL ONCE **on your PC**, not on the other PC:

```cmd
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h 127.0.0.1 -p 5000 -d iot_db -f "D:\DCN-LINK\sql\01_setup.sql"
```

This creates the deduplication `hardware_receipts` table if needed and keeps `text_messages`. Make sure your configured DB role is `iot_app` or adjust the grant statements in the SQL file.

## 5. Start and test

On YOUR PC (HUB), start first:

```cmd
cd /d D:\DCN-LINK
node index.js
```

Find YOUR PC's Wi-Fi IPv4 with `ipconfig`. On the OTHER PC, in PowerShell check (replace the IP):

```powershell
Test-NetConnection 192.168.1.10 -Port 3000
```

If needed, permit inbound TCP/3000 on YOUR PC's **Private** Windows firewall profile only, and make sure the Wi-Fi router doesn't have client isolation enabled. **Do not publicly expose port 3000.**

On OTHER PC (PEER) run:

```cmd
cd /d D:\DCN-LINK
node index.js
```

Verify on BOTH PCs:

- `http://localhost:3000/api/hardware/status` — `radio_ready: true`; `central_database_online: true`
- `http://localhost:3000/sender.html` — can send on either PC
- `http://localhost:3000/receiver.html` — shared inbox on either PC (enter view code)

**Test A → B:** On PC A sender website type `Hello from A`, enter sender code, click Send. ESP32 A -> ESP-NOW -> ESP32 B -> (PC B) -> central DB on your PC. The sender page waits for central DB confirmation.

**Test B → A:** Reverse the direction by using PC B sender website, then refresh inbox. Both sides use same firmware, same website and same Node.js backend.

On HUB PostgreSQL, confirm:

```sql
SELECT id, sender_id, receiver_id, message, transport, metadata->>'packet_id' AS packet_id, received_at
FROM text_messages WHERE metadata->>'source'='dcn_link_bidirectional'
ORDER BY id DESC LIMIT 10;
```

## 6. Troubleshooting

- `radio_ready: false`: check ESP32 port, IDE Serial Monitor closed, both firmware boards flashed, reset EN; Node pings until READY; COM reconnects automatically.
- `central_database_online: false` on PEER: verify HUB running first, correct `HUB_URL`, Windows Firewall on HUB, same LAN, no Wi-Fi client isolation.
- `HTTP 401`: sender/view codes in browser must match each PC's `.env`; gateway key must be same on both PCs.
- Message timed out: check the other board is powered, within ESP-NOW range, channel matches, and that receiver's Node process is running. Receiver queues copies of radio-received packets in `spool/` until central database is reachable. Since the status may arrive late, check the inbox before resending to avoid generating a second distinct message.
- `ENOENT package.json`: `cd /d D:\DCN-LINK` and confirm `dir` shows `index.js` and `package.json`.
- Two Node backends using port 3000 on SAME PC conflict. Stop the old backend on that PC (Ctrl+C) before starting this one.
- Only boot lines in Serial Monitor: wait or send `{"type":"ping"}` with newline and 115200 baud; correct firmware returns READY.
- `No module named ArduinoJson.h` or `DCNProtocol.h`: install ArduinoJson 7.x; extract `.ino` AND `.h` together, don't open from inside ZIP.
- The `spool/` folder is a temporary on-disk retry buffer (created automatically) containing plaintext messages: keep it private; do not delete it while unsaved receipts remain.

## 7. Limitations / future integration

This is a **bidirectional text prototype** for two ESP32s running ESP-NOW 1.x-compatible packets. It does **not** yet provide files, images, videos, encryption, recipient targeting, real-time streaming, or production-grade authentication. Radio packets are broadcast, so use it in a controlled environment. The local HTTP gateway key travels over your LAN; a secure deployed service should use TLS, stronger user auth and explicit paired/ encrypted ESP-NOW peers.

Your guide's database/API can be integrated by replacing the central HUB storage adapter after you receive the actual API/schema; no need to reflash ESP32 hardware then.

**Verification scope:** software JavaScript syntax, shared-file structure and protocol packet sizes can be checked here. Real firmware compilation, ESP-NOW delivery and database connectivity must be verified on the actual Windows PCs and ESP32 boards.
