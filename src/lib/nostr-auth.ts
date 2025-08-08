// src/lib/nostr-auth.ts
import { SimplePool, Event, getEventHash, getSignature, nip42 } from 'nostr-tools'
import type { NostrEvent } from 'nostr-tools'

export interface AuthConfig {
  relayUrl: string
  timeout?: number
}

export interface NostrSigner {
  getPublicKey(): Promise<string>
  signEvent(event: any): Promise<NostrEvent>
}

export class NostrAuthService {
  private pool: SimplePool
  private relay: any = null
  private isAuthenticated = false
  
  constructor(private config: AuthConfig) {
    this.pool = new SimplePool()
  }

  /**
   * Get NIP-07 signer from window.nostr
   */
  private async getNip07Signer(): Promise<NostrSigner> {
    if (typeof window === 'undefined' || !window.nostr) {
      throw new Error('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.')
    }

    return {
      getPublicKey: () => window.nostr.getPublicKey(),
      signEvent: (event) => window.nostr.signEvent(event)
    }
  }

  /**
   * Connect to relay and perform NIP-42 authentication
   */
  async authenticate(): Promise<boolean> {
    try {
      const signer = await this.getNip07Signer()
      const pubkey = await signer.getPublicKey()
      
      // Connect to relay and keep the connection
      this.relay = await this.pool.ensureRelay(this.config.relayUrl)
      
      console.log('Connected to relay:', this.config.relayUrl)

      // Listen for AUTH challenges
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Authentication timeout'))
        }, this.config.timeout || 10000)

        this.relay.on('auth', async (challenge: string) => {
          try {
            console.log('Received AUTH challenge:', challenge)
            
            // Create AUTH event according to NIP-42
            const authEvent = {
              kind: 22242,
              created_at: Math.floor(Date.now() / 1000),
              tags: [
                ['relay', this.config.relayUrl],
                ['challenge', challenge]
              ],
              content: '',
              pubkey
            }

            // Sign the AUTH event
            const signedAuthEvent = await signer.signEvent(authEvent)
            console.log('Signed AUTH event:', signedAuthEvent)

            // Send AUTH response
            this.relay.send(['AUTH', signedAuthEvent])
            
            // Wait for OK response
            this.relay.on('ok', (eventId: string, success: boolean, message: string) => {
              if (success) {
                console.log('Authentication successful')
                this.isAuthenticated = true
                clearTimeout(timeout)
                resolve(true)
              } else {
                console.error('Authentication failed:', message)
                clearTimeout(timeout)
                reject(new Error(`Authentication failed: ${message}`))
              }
            })

          } catch (error) {
            console.error('Error during AUTH:', error)
            clearTimeout(timeout)
            reject(error)
          }
        })

        // Trigger potential AUTH challenge by subscribing
        this.relay.send(['REQ', 'auth-trigger', { limit: 1 }])
      })

    } catch (error) {
      console.error('Authentication error:', error)
      throw error
    }
  }

  /**
   * Publish a kind 30078 event after authentication
   */
  async publishKind30078Event(content: string, dTag: string, additionalTags: string[][] = []): Promise<string> {
    if (!this.isAuthenticated || !this.relay) {
      throw new Error('Must authenticate first before publishing')
    }

    try {
      const signer = await this.getNip07Signer()
      const pubkey = await signer.getPublicKey()

      // Create kind 30078 event (Parameterized Replaceable Event)
      const event = {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', dTag], // Required for parameterized replaceable events
          ...additionalTags
        ],
        content,
        pubkey
      }

      // Sign the event
      const signedEvent = await signer.signEvent(event)
      console.log('Publishing kind 30078 event:', signedEvent)

      // Publish using the same authenticated connection
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Publish timeout'))
        }, this.config.timeout || 10000)

        this.relay.on('ok', (eventId: string, success: boolean, message: string) => {
          if (eventId === signedEvent.id) {
            clearTimeout(timeout)
            if (success) {
              console.log('Event published successfully:', eventId)
              resolve(eventId)
            } else {
              console.error('Event publish failed:', message)
              reject(new Error(`Publish failed: ${message}`))
            }
          }
        })

        // Send the event
        this.relay.send(['EVENT', signedEvent])
      })

    } catch (error) {
      console.error('Error publishing event:', error)
      throw error
    }
  }

  /**
   * Close the relay connection
   */
  async disconnect(): Promise<void> {
    if (this.relay) {
      this.relay.close()
      this.relay = null
    }
    this.pool.close([this.config.relayUrl])
    this.isAuthenticated = false
  }

  /**
   * Get authentication status
   */
  getAuthStatus(): boolean {
    return this.isAuthenticated
  }
}

// Global declarations for NIP-07
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: any): Promise<NostrEvent>
      getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
    }
  }
}