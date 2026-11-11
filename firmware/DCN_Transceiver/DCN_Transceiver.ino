// Upload this EXACT SAME sketch to both ESP32 boards.
// Arduino ESP32 board package 3.x; install ArduinoJson 7.x.
// Serial: 115200. ESP-NOW broadcast (unencrypted demo), fixed channel 1.
#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <ArduinoJson.h>
#include <string.h>
#include "DCNProtocol.h"
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

const uint8_t BROADCAST[6]={0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
struct RxEvent { DCNPacket packet; uint8_t mac[6]; int rssi; };
QueueHandle_t rxQueue;

String macText(const uint8_t *mac) {
  char s[18];
  snprintf(s,sizeof(s),"%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
  return String(s);
}
void printReady(){
  JsonDocument d;
  d["type"]="ready";
  d["device_id"]="ESP32_NODE";
  d["mac"]=WiFi.macAddress();
  serializeJson(d,Serial);
  Serial.println();
}
void printError(const char *message){
  JsonDocument d;
  d["type"]="error";
  d["message"]=message;
  serializeJson(d,Serial);
  Serial.println();
}

void onReceive(const esp_now_recv_info_t *info, const uint8_t *bytes, int len) {
  if (len != sizeof(DCNPacket) || !info || !rxQueue) return;
  RxEvent e={};
  memcpy(&e.packet,bytes,sizeof(DCNPacket));
  if (e.packet.magic != DCN_MAGIC) return;
  if (!memchr(e.packet.id,0,sizeof(e.packet.id))) return;
  if (e.packet.type==DCN_DATA) {
    if (!memchr(e.packet.text,0,sizeof(e.packet.text)) ||
        !memchr(e.packet.sender_id,0,sizeof(e.packet.sender_id))) return;
  }
  memcpy(e.mac,info->src_addr,6);
  e.rssi=(info->rx_ctrl ? info->rx_ctrl->rssi : -127);
  xQueueSend(rxQueue,&e,0);
}

void sendAck(const RxEvent &e) {
  if (!esp_now_is_peer_exist(e.mac)) {
    esp_now_peer_info_t peer={};
    memcpy(peer.peer_addr,e.mac,6);
    peer.channel=DCN_CHANNEL;
    peer.ifidx=WIFI_IF_STA;
    peer.encrypt=false;
    if (esp_now_add_peer(&peer)!=ESP_OK) { printError("ack_add_peer_failed"); return; }
  }
  DCNPacket ack={};
  ack.magic=DCN_MAGIC; ack.type=DCN_ACK;
  strncpy(ack.id,e.packet.id,sizeof(ack.id)-1);
  if (esp_now_send(e.mac,(const uint8_t*)&ack,sizeof(ack)) != ESP_OK)
    printError("ack_radio_send_failed");
}

void processRx(const RxEvent &e){
  if(e.packet.type==DCN_ACK){
    JsonDocument d;
    d["type"]="radio_ack";
    d["id"]=e.packet.id;
    d["peer_mac"]=macText(e.mac);
    serializeJson(d,Serial);Serial.println();
    return;
  }
  if(e.packet.type!=DCN_DATA) return;
  JsonDocument d;
  d["type"]="received";
  d["id"]=e.packet.id;
  d["sender_id"]=e.packet.sender_id;
  d["text"]=e.packet.text;
  d["from_mac"]=macText(e.mac);
  d["rssi_dbm"]=e.rssi;
  d["uptime_ms"]=millis();
  serializeJson(d,Serial);Serial.println();
  sendAck(e);
}

void processSerialLine(String line){
  JsonDocument d;
  if(deserializeJson(d,line)) {printError("invalid_serial_json");return;}
  const char *kind=d["type"] | "";
  if(strcmp(kind,"ping")==0){printReady();return;}
  if(strcmp(kind,"deliver")!=0){printError("unknown_serial_command");return;}
  const char *id=d["id"] | "";
  const char *sender=d["sender_id"] | "";
  const char *text=d["text"] | "";
  if(strlen(id)!=36 || strlen(sender)<1 || strlen(sender)>32 ||
     strlen(text)<1 || strlen(text)>160) {printError("invalid_message_length");return;}
  DCNPacket packet={};
  packet.magic=DCN_MAGIC;packet.type=DCN_DATA;
  memcpy(packet.id,id,strlen(id));
  memcpy(packet.sender_id,sender,strlen(sender));
  memcpy(packet.text,text,strlen(text));
  esp_err_t result=esp_now_send(BROADCAST,(const uint8_t*)&packet,sizeof(packet));
  JsonDocument out;
  out["type"]= result==ESP_OK ? "radio_queued" : "radio_error";
  out["id"]=id;
  out["status"]=(int)result;
  serializeJson(out,Serial);Serial.println();
}

void setup(){
  Serial.begin(115200);
  Serial.setTimeout(200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  if(esp_wifi_set_channel(DCN_CHANNEL,WIFI_SECOND_CHAN_NONE)!=ESP_OK){
    printError("wifi_channel_failed");return;
  }
  rxQueue=xQueueCreate(16,sizeof(RxEvent));
  if(!rxQueue){printError("rx_queue_failed");return;}
  if(esp_now_init()!=ESP_OK){printError("esp_now_init_failed");return;}
  esp_now_peer_info_t peer={};
  memcpy(peer.peer_addr,BROADCAST,6);
  peer.channel=DCN_CHANNEL; peer.ifidx=WIFI_IF_STA;
  peer.encrypt=false;
  if(esp_now_add_peer(&peer)!=ESP_OK){printError("broadcast_peer_failed");return;}
  esp_now_register_recv_cb(onReceive);
  printReady();
}
void loop(){
  RxEvent e;
  // Drain incoming radio packets promptly.
  while(rxQueue && xQueueReceive(rxQueue,&e,0)==pdTRUE) processRx(e);
  if(Serial.available()) processSerialLine(Serial.readStringUntil('\n'));
  delay(2);
}
