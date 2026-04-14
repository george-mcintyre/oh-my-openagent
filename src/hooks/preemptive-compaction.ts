import { log } from "../shared/logger"
import type { OhMyOpenCodeConfig } from "../config"
import {
  resolveActualContextLimit,
  type ContextLimitModelCacheState,
} from "../shared/context-limit-resolver"

import {
  type CachedCompactionState,
  type TokenInfo,
  withTimeout,
} from "./preemptive-compaction-shared"
import { maybeApplyContextUpgrade } from "./preemptive-compaction-context-upgrade"
import { resolveCompactionModel } from "./shared/compaction-model-resolver"
import { createPostCompactionDegradationMonitor } from "./preemptive-compaction-degradation-monitor"

const PREEMPTIVE_COMPACTION_TIMEOUT_MS = 60_000
const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78
const PREEMPTIVE_COMPACTION_COOLDOWN_MS = 60_000

type PluginInput = {
  client: {
    session: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: (...args: any[]) => any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      summarize: (...args: any[]) => any
    }
    tui: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      showToast: (...args: any[]) => any
    }
  }
  directory: string
}

export function createPreemptiveCompactionHook(
  ctx: PluginInput,
  pluginConfig: OhMyOpenCodeConfig,
  modelCacheState?: ContextLimitModelCacheState,
) {
  const compactionInProgress = new Set<string>()
  const compactedSessions = new Set<string>()
  const upgradedSessions = new Set<string>()
  const bypassedUpgradeSessions = new Set<string>()
  const lastCompactionTime = new Map<string, number>()
  const tokenCache = new Map<string, CachedCompactionState>()

  const postCompactionMonitor = createPostCompactionDegradationMonitor({
    client: ctx.client,
    directory: ctx.directory,
    pluginConfig,
    tokenCache,
    compactionInProgress,
  })

  const toolExecuteAfter = async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { title: string; output: string; metadata: unknown }
  ) => {
    const { sessionID } = input
    if (compactedSessions.has(sessionID) || compactionInProgress.has(sessionID)) return

    const lastTime = lastCompactionTime.get(sessionID)
    if (lastTime && Date.now() - lastTime < PREEMPTIVE_COMPACTION_COOLDOWN_MS) return

    const cached = tokenCache.get(sessionID)
    if (!cached) return

    const actualLimit = resolveActualContextLimit(
      cached.providerID,
      cached.modelID,
      modelCacheState,
    )

    if (actualLimit === null) {
      log("[preemptive-compaction] Skipping preemptive compaction: unknown context limit for model", {
        providerID: cached.providerID,
        modelID: cached.modelID,
      })
      return
    }

    const totalInputTokens = (cached.tokens.input ?? 0) + (cached.tokens.cache?.read ?? 0)
    const usageRatio = totalInputTokens / actualLimit
    if (usageRatio < PREEMPTIVE_COMPACTION_THRESHOLD || !cached.modelID) return

    compactionInProgress.add(sessionID)

    try {
      const upgradeResult = maybeApplyContextUpgrade({
        sessionID,
        pluginConfig,
        modelCacheState,
        cached,
        currentLimit: actualLimit,
        totalInputTokens,
        tokenCache,
        upgradedSessions,
        bypassedUpgradeSessions,
      })

      if (
        upgradeResult.upgraded
        && upgradeResult.upgradedLimit !== undefined
        && totalInputTokens / upgradeResult.upgradedLimit < PREEMPTIVE_COMPACTION_THRESHOLD
      ) {
        const upgradedModel = tokenCache.get(sessionID) ?? cached
        lastCompactionTime.set(sessionID, Date.now())

        ctx.client.tui.showToast({
          body: {
            title: "Context upgraded",
            message: `Switched to ${upgradedModel.providerID}/${upgradedModel.modelID} and compacted session to free up context.`,
            variant: "info",
            duration: 6000,
          },
        }).catch((toastError: unknown) => {
          log("[preemptive-compaction] Failed to show upgrade toast", {
            sessionID,
            toastError: String(toastError),
          })
        })

        await withTimeout(
          ctx.client.session.summarize({
            path: { id: sessionID },
            body: { providerID: upgradedModel.providerID, modelID: upgradedModel.modelID, auto: true } as never,
            query: { directory: ctx.directory },
          }),
          PREEMPTIVE_COMPACTION_TIMEOUT_MS,
          `Context upgrade compaction timed out after ${PREEMPTIVE_COMPACTION_TIMEOUT_MS}ms`,
        )

        compactedSessions.add(sessionID)
        return
      }

      const effectiveModel = tokenCache.get(sessionID) ?? cached
      const { providerID: targetProviderID, modelID: targetModelID } = resolveCompactionModel(
        pluginConfig,
        sessionID,
        effectiveModel.providerID,
        effectiveModel.modelID,
      )

      lastCompactionTime.set(sessionID, Date.now())

      await withTimeout(
        ctx.client.session.summarize({
          path: { id: sessionID },
          body: { providerID: targetProviderID, modelID: targetModelID, auto: true } as never,
          query: { directory: ctx.directory },
        }),
        PREEMPTIVE_COMPACTION_TIMEOUT_MS,
        `Compaction summarize timed out after ${PREEMPTIVE_COMPACTION_TIMEOUT_MS}ms`,
      )

      compactedSessions.add(sessionID)
    } catch (error) {
      log("[preemptive-compaction] Compaction failed", {
        sessionID,
        providerID: cached.providerID,
        modelID: cached.modelID,
        error: String(error),
      })
      ctx.client.tui.showToast({
        body: {
          title: "Preemptive compaction failed",
          message: `Context window is above ${Math.round(PREEMPTIVE_COMPACTION_THRESHOLD * 100)}% and auto-compaction could not run. The session may grow large. Error: ${String(error)}`,
          variant: "warning",
          duration: 10000,
        },
      }).catch((toastError: unknown) => {
        log("[preemptive-compaction] Failed to show toast", {
          sessionID,
          toastError: String(toastError),
        })
      })
    } finally {
      compactionInProgress.delete(sessionID)
    }
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const sessionID = (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
        compactionInProgress.delete(sessionID)
        compactedSessions.delete(sessionID)
        upgradedSessions.delete(sessionID)
        bypassedUpgradeSessions.delete(sessionID)
        lastCompactionTime.delete(sessionID)
        tokenCache.delete(sessionID)
        postCompactionMonitor.clear(sessionID)
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = (props?.sessionID as string | undefined)
        ?? (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
        postCompactionMonitor.onSessionCompacted(sessionID)
      }
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as {
        id?: string
        role?: string
        sessionID?: string
        providerID?: string
        modelID?: string
        finish?: boolean
        tokens?: TokenInfo
      } | undefined

      if (!info || info.role !== "assistant" || !info.finish || !info.sessionID) return

      if (info.providerID && info.tokens) {
        tokenCache.set(info.sessionID, {
          providerID: info.providerID,
          modelID: info.modelID ?? "",
          tokens: info.tokens,
        })
      }
      compactedSessions.delete(info.sessionID)

      await postCompactionMonitor.onAssistantMessageUpdated({
        sessionID: info.sessionID,
        id: info.id,
      })
    }
  }

  return {
    "tool.execute.after": toolExecuteAfter,
    event: eventHandler,
  }
}
