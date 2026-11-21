import { describe, it, expect } from 'vitest'
import {
  validateQrGatewayUrl,
  normalizeQrToDataUrl,
  parseQrWebhookPayload,
} from './qr-gateway'

describe('validateQrGatewayUrl (SSRF protection)', () => {
  it('accepts valid public HTTPS gateway URLs and trims trailing slash', () => {
    expect(validateQrGatewayUrl('https://evo.minhaempresa.com.br/')).toBe(
      'https://evo.minhaempresa.com.br',
    )
    expect(validateQrGatewayUrl('https://waha.example.org/api')).toBe(
      'https://waha.example.org/api',
    )
  })

  it('rejects HTTP, loopback, private IPv4/IPv6, and cloud metadata addresses', () => {
    expect(() => validateQrGatewayUrl('http://evo.minhaempresa.com.br')).toThrow()
    expect(() => validateQrGatewayUrl('https://localhost:8080')).toThrow()
    expect(() => validateQrGatewayUrl('https://127.0.0.1:8080')).toThrow()
    expect(() => validateQrGatewayUrl('https://10.0.0.5')).toThrow()
    expect(() => validateQrGatewayUrl('https://172.16.0.10')).toThrow()
    expect(() => validateQrGatewayUrl('https://192.168.1.100')).toThrow()
    expect(() => validateQrGatewayUrl('https://169.254.169.254/latest/meta-data')).toThrow()
    expect(() => validateQrGatewayUrl('https://metadata.google.internal')).toThrow()
    expect(() => validateQrGatewayUrl('https://user:pass@evo.example.org')).toThrow()
  })
})

describe('normalizeQrToDataUrl', () => {
  it('passes through existing data URLs and converts raw QR strings to PNG data URLs', async () => {
    const existing = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    expect(await normalizeQrToDataUrl(existing)).toBe(existing)

    const converted = await normalizeQrToDataUrl('2@demo-qr-pairing-token')
    expect(converted).toMatch(/^data:image\/png;base64,/)
  })
})

describe('parseQrWebhookPayload', () => {
  it('parses Evolution API v2 inbound text messages', () => {
    const evt = parseQrWebhookPayload({
      event: 'messages.upsert',
      data: {
        key: {
          remoteJid: '5511999887766@s.whatsapp.net',
          fromMe: false,
          id: 'EVO_MSG_123',
        },
        pushName: 'João Silva',
        message: {
          conversation: 'Olá, quero um orçamento!',
        },
      },
    })

    expect(evt).toMatchObject({
      kind: 'message',
      fromPhone: '5511999887766',
      contactName: 'João Silva',
      messageId: 'EVO_MSG_123',
      contentType: 'text',
      contentText: 'Olá, quero um orçamento!',
    })
  })

  it('ignores Evolution API group messages and outbound fromMe echoes', () => {
    expect(
      parseQrWebhookPayload({
        event: 'messages.upsert',
        data: {
          key: { remoteJid: '12036301@g.us', fromMe: false, id: 'G1' },
          message: { conversation: 'Mensagem de grupo' },
        },
      }),
    ).toEqual({ kind: 'ignored', reason: 'group_or_status' })

    expect(
      parseQrWebhookPayload({
        event: 'messages.upsert',
        data: {
          key: { remoteJid: '5511999887766@s.whatsapp.net', fromMe: true, id: 'M1' },
          message: { conversation: 'Echo' },
        },
      }),
    ).toEqual({ kind: 'ignored', reason: 'from_me' })
  })

  it('parses Evolution API connection updates', () => {
    expect(
      parseQrWebhookPayload({
        event: 'connection.update',
        data: { state: 'open', wuid: '5511988887777@s.whatsapp.net' },
      }),
    ).toEqual({
      kind: 'connection',
      status: 'connected',
      phoneNumber: '5511988887777',
    })
  })

  it('parses WAHA inbound messages', () => {
    const evt = parseQrWebhookPayload({
      event: 'message',
      payload: {
        id: 'WAHA_42',
        from: '5521987654321@c.us',
        fromMe: false,
        body: 'Boa tarde!',
        _data: { notifyName: 'Ana Paula' },
      },
    })

    expect(evt).toMatchObject({
      kind: 'message',
      fromPhone: '5521987654321',
      contactName: 'Ana Paula',
      messageId: 'WAHA_42',
      contentType: 'text',
      contentText: 'Boa tarde!',
    })
  })

  it('parses custom JSON webhook payloads', () => {
    const evt = parseQrWebhookPayload({
      from: '+55 (31) 99111-2233',
      name: 'Lucas',
      text: 'Teste via webhook personalizado',
      messageId: 'CUSTOM_1',
    })

    expect(evt).toMatchObject({
      kind: 'message',
      fromPhone: '5531991112233',
      contactName: 'Lucas',
      messageId: 'CUSTOM_1',
      contentType: 'text',
      contentText: 'Teste via webhook personalizado',
    })
  })
})
