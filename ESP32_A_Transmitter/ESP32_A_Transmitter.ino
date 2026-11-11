#include <Arduino.h>
#include <ArduinoJson.h>  // Arduino IDE: install ArduinoJson 7.x
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include "DCNProtocol.h"

bool radioReady = false;

struct AckEvent { char id[37]; };
QueueHandle_t ackQueue = nullptr;
DcnPacket outstanding = {};
bool waitingForAck = false;
uint32_t lastSentAt = 0;
uint8_t attempt = 0;
String deferredLine; // Hold one new serial command until the previous radio ACK completes.

void reportReady() {
  if (!radioReady) return;
  JsonDocument doc;
  doc["type"] = "ready";
  doc["device_id"] = "ESP32_A";
  doc["mac"] = WiFi.macAddress();
  serializeJson(doc, Serial);
  Serial.println();
}

void reportError(const char *reason) {
  JsonDocument doc;
  doc["type"] = "error";
  doc["message"] = reason;
  serializeJson(doc, Serial);
  Serial.println();
}

void reportRadioResult(const char *type, const char *id) {
  JsonDocument doc;
  doc["type"] = type;
  doc["id"] = id;
  serializeJson(doc, Serial);
  Serial.println();
}

// ESP-NOW receive callback runs on Wi-Fi task, NOT on Arduino main loop.
void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(DcnPacket) || !ackQueue) return;
  DcnPacket packet;
  memcpy(&packet, data, sizeof(packet));
  if (packet.magic != DCN_MAGIC || packet.version != DCN_VERSION ||
      packet.type != DCN_ACK) return;
  packet.id[sizeof(packet.id)-1] = '\0';
  AckEvent ack = {};
  memcpy(ack.id, packet.id, sizeof(ack.id));
  xQueueSend(ackQueue, &ack, 0);
}

void sendAttempt() {
  if (!waitingForAck) return;
  attempt++;
  lastSentAt = millis();
  esp_err_t result = esp_now_send(
    DCN_BROADCAST,
    reinterpret_cast<const uint8_t *>(&outstanding),
    sizeof(outstanding)
  );
  if (result != ESP_OK) reportError("Radio send could not be queued");
}

void handleSerialLine(const String &line) {
  if (line.length() > 800) { reportError("Serial JSON too long"); return; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) { reportError("Malformed serial JSON"); return; }
  const char *type = doc["type"] | "";
  if (strcmp(type, "ping") == 0) { reportReady(); return; }
  if (strcmp(type, "deliver") != 0) return;
  if (waitingForAck) {
    if (deferredLine.length() == 0) deferredLine = line;
    else reportError("Transmitter serial queue full");
    return;
  }

  const char *id = doc["id"] | "";
  const char *sender = doc["sender_id"] | "";
  const char *text = doc["text"] | "";
  const size_t idLength = strlen(id);
  const size_t senderLength = strlen(sender);
  const size_t textLength = strlen(text); // byte length of UTF-8
  if (idLength != 36 || senderLength < 1 || senderLength > 32 ||
      textLength < 1 || textLength > 160) {
    reportError("Invalid ID, sender or text byte length");
    return;
  }

  memset(&outstanding, 0, sizeof(outstanding));
  outstanding.magic = DCN_MAGIC;
  outstanding.version = DCN_VERSION;
  outstanding.type = DCN_DATA;
  memcpy(outstanding.id, id, idLength);
  memcpy(outstanding.sender, sender, senderLength);
  memcpy(outstanding.text, text, textLength);
  waitingForAck = true;
  attempt = 0;
  sendAttempt();
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(100);
  delay(600);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  if (esp_wifi_set_channel(DCN_CHANNEL, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    reportError("Failed to set wireless channel"); return;
  }
  ackQueue = xQueueCreate(8, sizeof(AckEvent));
  if (!ackQueue || esp_now_init() != ESP_OK) {
    reportError("ESP-NOW initialization failed"); return;
  }
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, DCN_BROADCAST, 6);
  peer.channel = DCN_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) {
    reportError("Could not add ESP-NOW broadcast peer"); return;
  }
  esp_now_register_recv_cb(onReceive);
  radioReady = true;
  reportReady();
}

void loop() {
  AckEvent ack;
  while (ackQueue && xQueueReceive(ackQueue, &ack, 0) == pdTRUE) {
    if (waitingForAck && strcmp(ack.id, outstanding.id) == 0) {
      waitingForAck = false;
      reportRadioResult("radio_ack", ack.id);
    }
  }

  if (waitingForAck && millis() - lastSentAt > 1100) {
    if (attempt < 3) sendAttempt();
    else {
      waitingForAck = false;
      reportRadioResult("radio_failed", outstanding.id);
    }
  }

  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length()) handleSerialLine(line);
  }
  if (!waitingForAck && deferredLine.length()) {
    String nextLine = deferredLine;
    deferredLine = "";
    handleSerialLine(nextLine);
  }
  delay(5);
}
