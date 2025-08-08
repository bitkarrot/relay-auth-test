// src/composables/useNostrAuth.ts
import { NostrAuthService } from '../lib/nostr-auth'
import type { AuthConfig } from '../lib/nostr-auth'

export interface UseNostrAuthOptions {
  relayUrl?: string
  timeout?: number
  autoConnect?: boolean
}

export interface NostrAuthState {
  isAuthenticated: boolean
  isConnecting: boolean
  error: string | null
  eventId: string | null
}

export class UseNostrAuth {
  private service: NostrAuthService | null = null
  private state: NostrAuthState = {
    isAuthenticated: false,
    isConnecting: false,
    error: null,
    eventId: null
  }
  
  private listeners: Set<(state: NostrAuthState) => void> = new Set()

  constructor(private options: UseNostrAuthOptions = {}) {
    // Get relay URL from environment or options
    const relayUrl = options.relayUrl || 
                    (typeof process !== 'undefined' ? process.env.HIVETALK_RELAYS : null) ||
                    'ws://localhost:3334'

    const config: AuthConfig = {
      relayUrl,
      timeout: options.timeout || 15000
    }

    this.service = new NostrAuthService(config)

    // Auto-connect if specified
    if (options.autoConnect && typeof window !== 'undefined') {
      window.addEventListener('load', () => {
        if (window.nostr) {
          this.authenticate()
        }
      })
    }
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: NostrAuthState) => void) {
    this.listeners.add(listener)
    // Immediately call with current state
    listener({ ...this.state })
    
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Update state and notify listeners
   */
  private updateState(updates: Partial<NostrAuthState>) {
    this.state = { ...this.state, ...updates }
    this.listeners.forEach(listener => listener({ ...this.state }))
  }

  /**
   * Check if NIP-07 extension is available
   */
  isNip07Available(): boolean {
    return typeof window !== 'undefined' && !!window.nostr
  }

  /**
   * Authenticate with the relay
   */
  async authenticate(): Promise<boolean> {
    if (!this.service) {
      this.updateState({ error: 'Auth service not initialized' })
      return false
    }

    if (!this.isNip07Available()) {
      this.updateState({ error: 'NIP-07 extension not found' })
      return false
    }

    try {
      this.updateState({ 
        isConnecting: true, 
        error: null 
      })

      const success = await this.service.authenticate()
      
      this.updateState({
        isAuthenticated: success,
        isConnecting: false,
        error: success ? null : 'Authentication failed'
      })

      return success

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown authentication error'
      this.updateState({
        isAuthenticated: false,
        isConnecting: false,
        error: errorMessage
      })
      return false
    }
  }

  /**
   * Publish a kind 30078 event
   */
  async publishEvent(
    content: string, 
    dTag: string, 
    additionalTags: string[][] = []
  ): Promise<string | null> {
    if (!this.service || !this.state.isAuthenticated) {
      this.updateState({ error: 'Must authenticate first' })
      return null
    }

    try {
      this.updateState({ error: null })
      
      const eventId = await this.service.publishKind30078Event(content, dTag, additionalTags)
      
      this.updateState({ 
        eventId,
        error: null 
      })

      return eventId

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown publish error'
      this.updateState({ error: errorMessage })
      return null
    }
  }

  /**
   * Disconnect from the relay
   */
  async disconnect(): Promise<void> {
    if (this.service) {
      await this.service.disconnect()
      this.updateState({
        isAuthenticated: false,
        isConnecting: false,
        error: null,
        eventId: null
      })
    }
  }

  /**
   * Get current state
   */
  getState(): NostrAuthState {
    return { ...this.state }
  }

  /**
   * Get auth service instance (for advanced usage)
   */
  getService(): NostrAuthService | null {
    return this.service
  }
}

// Factory function for easy usage in Astro pages
export function createNostrAuth(options?: UseNostrAuthOptions): UseNostrAuth {
  return new UseNostrAuth(options)
}

// Utility functions for common operations
export const NostrAuthUtils = {
  /**
   * Create a simple UI state manager for DOM updates
   */
  createUIManager(auth: UseNostrAuth, elements: {
    statusElement?: HTMLElement
    authButton?: HTMLButtonElement
    publishSection?: HTMLElement
    disconnectButton?: HTMLButtonElement
  }) {
    const { statusElement, authButton, publishSection, disconnectButton } = elements

    // Subscribe to auth state changes
    auth.subscribe((state) => {
      // Update status
      if (statusElement) {
        let statusClass = 'info'
        let message = 'Ready to authenticate'

        if (state.isConnecting) {
          message = 'Connecting and authenticating...'
        } else if (state.isAuthenticated) {
          message = '✅ Authenticated successfully!'
          statusClass = 'success'
        } else if (state.error) {
          message = `❌ ${state.error}`
          statusClass = 'error'
        }

        statusElement.className = `status ${statusClass}`
        statusElement.textContent = message
      }

      // Update auth button
      if (authButton) {
        authButton.disabled = state.isConnecting
        authButton.textContent = state.isConnecting ? 
          '🔄 Authenticating...' : 
          '🔑 Authenticate with Relay'
        authButton.style.display = state.isAuthenticated ? 'none' : 'inline-block'
      }

      // Show/hide publish section
      if (publishSection) {
        publishSection.style.display = state.isAuthenticated ? 'block' : 'none'
      }

      // Show/hide disconnect button
      if (disconnectButton) {
        disconnectButton.style.display = state.isAuthenticated ? 'inline-block' : 'none'
      }
    })

    return {
      async authenticate() {
        return auth.authenticate()
      },
      async publishEvent(content: string, dTag: string, additionalTags: string[][] = []) {
        return auth.publishEvent(content, dTag, additionalTags)
      },
      async disconnect() {
        return auth.disconnect()
      }
    }
  }
}
