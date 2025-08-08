// src/lib/relay-auth.ts
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
  private relay: WebSocket | null = null
  private isAuthenticated = false
  private authChallenge: string | null = null
  
  constructor(private config: AuthConfig) {
    // Direct WebSocket implementation - no SimplePool needed
  }

  /**
   * Get NIP-07 signer from window.nostr
   */
  private async getNip07Signer(): Promise<NostrSigner> {
    if (typeof window === 'undefined' || !window.nostr) {
      throw new Error('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.')
    }

    return {
      getPublicKey: () => window.nostr!.getPublicKey(),
      signEvent: (event) => window.nostr!.signEvent(event)
    }
  }

  /**
   * Connect to relay and perform NIP-42 authentication
   */
  async authenticate(): Promise<boolean> {
    try {
      const signer = await this.getNip07Signer()
      const pubkey = await signer.getPublicKey()
      
      console.log('🔌 Connecting to relay:', this.config.relayUrl)

      // Connect using direct WebSocket like in nip7.astro
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Authentication timeout'))
        }, this.config.timeout || 10000)

        try {
          this.relay = new WebSocket(this.config.relayUrl)
          
          this.relay.onopen = () => {
            console.log('✅ Connected to relay')
            
            // Send a REQ to potentially trigger AUTH requirement
            const reqMsg = JSON.stringify(['REQ', 'auth_trigger', { kinds: [1], limit: 1 }])
            this.relay!.send(reqMsg)
            console.log('📤 Sent test REQ to trigger auth requirement')
          }
          
          this.relay.onmessage = async (event) => {
            try {
              const message = JSON.parse(event.data)
              console.log(`📥 Received: ${JSON.stringify(message)}`)
              
              if (message[0] === 'AUTH') {
                // Handle AUTH challenge
                this.authChallenge = message[1]
                console.log(`🔐 Received AUTH challenge: ${this.authChallenge}`)
                
                // Create AUTH event according to NIP-42
                const authEvent = {
                  kind: 22242,
                  created_at: Math.floor(Date.now() / 1000),
                  tags: [
                    ['relay', this.config.relayUrl],
                    ['challenge', this.authChallenge]
                  ],
                  content: '',
                  pubkey
                }

                // Sign the AUTH event
                const signedAuthEvent = await signer.signEvent(authEvent)
                console.log('Signed AUTH event:', signedAuthEvent)

                // Send AUTH response
                const authMsg = JSON.stringify(['AUTH', signedAuthEvent])
                this.relay!.send(authMsg)
                console.log('📤 Sent AUTH response')
                
              } else if (message[0] === 'OK' && message[2] === true && message[1].length === 64) {
                // AUTH event was accepted
                console.log('✅ Authentication successful!')
                this.isAuthenticated = true
                clearTimeout(timeout)
                resolve(true)
                
              } else if (message[0] === 'CLOSED') {
                if (message[2] && message[2].startsWith('auth-required')) {
                  console.log('🔒 Auth required for this operation')
                }
              } else if (message[0] === 'OK' && message[2] === false) {
                console.log(`❌ Event rejected: ${message[3] || 'Unknown error'}`)
                if (message[3] && message[3].includes('auth-required')) {
                  console.log('🔒 Publishing requires authentication')
                  clearTimeout(timeout)
                  reject(new Error('Authentication required but failed'))
                }
              }
            } catch (parseError) {
              console.error('Error parsing message:', parseError)
            }
          }
          
          this.relay.onerror = (error) => {
            console.error(`❌ WebSocket error:`, error)
            clearTimeout(timeout)
            reject(new Error('WebSocket connection failed'))
          }
          
          this.relay.onclose = () => {
            console.log('🔌 Connection closed')
            this.isAuthenticated = false
          }
          
        } catch (error) {
          console.error(`❌ Connection error:`, error)
          clearTimeout(timeout)
          reject(error)
        }
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

      // Publish using the same authenticated WebSocket connection
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Publish timeout'))
        }, this.config.timeout || 10000)

        // Set up message handler for this publish operation
        const originalOnMessage = this.relay!.onmessage
        
        this.relay!.onmessage = (event) => {
          // Call original handler first
          if (originalOnMessage) {
            originalOnMessage.call(this.relay!, event)
          }
          
          try {
            const message = JSON.parse(event.data)
            console.log(`📥 Publish response: ${JSON.stringify(message)}`)
            
            if (message[0] === 'OK' && message[1] === signedEvent.id) {
              clearTimeout(timeout)
              if (message[2] === true) {
                console.log('Event published successfully:', signedEvent.id)
                resolve(signedEvent.id)
              } else {
                console.error('Event publish failed:', message[3] || 'Unknown error')
                reject(new Error(`Publish failed: ${message[3] || 'Unknown error'}`))
              }
              // Restore original message handler
              this.relay!.onmessage = originalOnMessage
            }
          } catch (parseError) {
            console.error('Error parsing publish response:', parseError)
          }
        }

        // Send the event
        const eventMsg = JSON.stringify(['EVENT', signedEvent])
        this.relay!.send(eventMsg)
        console.log('📤 Sent EVENT for publishing')
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
    this.isAuthenticated = false
    this.authChallenge = null
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