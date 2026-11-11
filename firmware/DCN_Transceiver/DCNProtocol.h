#pragma once
#include <stdint.h>
// Compatible with ESP-NOW v1 250-byte maximum data packet.
static const uint32_t DCN_MAGIC = 0x44434E34;
static const uint8_t DCN_DATA = 1;
static const uint8_t DCN_ACK = 2;
static const int DCN_CHANNEL = 1;
struct __attribute__((packed)) DCNPacket {
  uint32_t magic;
  uint8_t type;
  char id[37];         // UUID plus NUL
  char sender_id[33];  // max 32 ASCII bytes plus NUL
  char text[161];      // max 160 UTF-8 bytes plus NUL
};
static_assert(sizeof(DCNPacket) <= 250, "Packet must fit ESP-NOW v1");
