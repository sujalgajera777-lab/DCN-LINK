#ifndef DCN_PROTOCOL_H
#define DCN_PROTOCOL_H

#include <stdint.h>

// Exactly 237 bytes: compatible with ESP-NOW v1 maximum payload of 250 bytes.
// Keep this header IDENTICAL on transmitter and receiver.
static constexpr uint32_t DCN_MAGIC = 0x44434E31UL;
static constexpr uint8_t DCN_VERSION = 1;
static constexpr uint8_t DCN_CHANNEL = 1;
static constexpr uint8_t DCN_DATA = 1;
static constexpr uint8_t DCN_ACK = 2;

struct __attribute__((packed)) DcnPacket {
  uint32_t magic;    // 4
  uint8_t version;   // 1
  uint8_t type;      // 1
  char id[37];       // UUID text + NUL
  char sender[33];   // up to 32 ASCII bytes + NUL
  char text[161];    // up to 160 UTF-8 bytes + NUL
};

static_assert(sizeof(DcnPacket) == 237, "DcnPacket must fit an ESP-NOW v1 payload");

static const uint8_t DCN_BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

#endif
