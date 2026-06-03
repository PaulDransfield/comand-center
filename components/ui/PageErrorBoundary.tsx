'use client'
// components/ui/PageErrorBoundary.tsx
//
// Page-scoped error boundary. Catches React render exceptions thrown
// by children, reports them to Sentry, and shows an in-page fallback
// with the actual error message — instead of the global "Something
// went wrong" screen that hides the underlying cause.
//
// Use this around individual surfaces (e.g. the prep list) where a
// failure inside one feature should be debuggable without hiding the
// rest of the app behind the global fallback. Each surface gets its
// own boundary so the owner sees a specific message they can screenshot
// and send back.

import * as Sentry from '@sentry/nextjs'
import { Component, type ReactNode } from 'react'
import { UXP } from '@/lib/constants/tokens'

interface Props {
  children: ReactNode
  /** Short label for the surface that crashed (e.g. "Prep list"). Used in fallback copy. */
  surface:  string
}

interface State {
  error: Error | null
}

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
      tags:     { surface: this.props.surface },
    })
  }

  reset = () => { this.setState({ error: null }) }

  render() {
    if (this.state.error) {
      const e = this.state.error
      return (
        <div style={{
          margin:       '24px auto', maxWidth: 720,
          padding:      '20px 24px',
          background:   UXP.cardBg,
          border:       `0.5px solid ${UXP.rose}`,
          borderRadius: UXP.r_lg,
          color:        UXP.ink1,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase' as const, color: UXP.roseText, marginBottom: 6,
          }}>
            {this.props.surface} — error
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 10 }}>
            Something broke while rendering this page.
          </div>
          <pre style={{
            margin:       '0 0 12px',
            padding:      '8px 10px',
            background:   UXP.subtleBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_sm,
            fontSize:     11,
            color:        UXP.ink2,
            whiteSpace:   'pre-wrap' as const,
            overflowWrap: 'anywhere' as const,
            fontFamily:   'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}>
            {e.name}: {e.message}
          </pre>
          <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 12, lineHeight: 1.5 }}>
            The error has been logged. Try the action again — if it keeps
            happening, screenshot this message and send it through.
          </div>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600,
              background: UXP.lavDeep, color: '#fff', border: 'none',
              borderRadius: UXP.r_sm, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
