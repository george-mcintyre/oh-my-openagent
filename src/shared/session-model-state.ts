export type SessionModel = { providerID: string; modelID: string }

const sessionModels = new Map<string, SessionModel>()
const contextUpgradedSessions = new Set<string>()

export function setSessionModel(sessionID: string, model: SessionModel): void {
  sessionModels.set(sessionID, model)
}

export function getSessionModel(sessionID: string): SessionModel | undefined {
  return sessionModels.get(sessionID)
}

export function clearSessionModel(sessionID: string): void {
  sessionModels.delete(sessionID)
  contextUpgradedSessions.delete(sessionID)
}

export function markSessionContextUpgraded(sessionID: string): void {
  contextUpgradedSessions.add(sessionID)
}

export function isSessionContextUpgraded(sessionID: string): boolean {
  return contextUpgradedSessions.has(sessionID)
}
