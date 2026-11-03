import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { api, clearSession, loadSession, saveSession, setPendingToken, setUnauthorizedHandler, type StoredSession } from './api'

interface AuthState {
  session: StoredSession | null
  login: (loginName: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession())
  const navigate = useNavigate()

  const logout = useCallback(async () => {
    await api.logout()
    clearSession()
    setSession(null)
    navigate('/login', { replace: true })
  }, [navigate])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession()
      setSession(null)
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

  const value = useMemo<AuthState>(
    () => ({
      session,
      async login(loginName, password) {
        const resp = await api.login({ loginName, password, platform: 'PDA' })
        // 过渡令牌：login 与 me 两步之间请求仍可携带 Bearer（会话尚未落库）
        setPendingToken(resp.token)
        try {
          const me = await api.me()
          const next: StoredSession = {
            token: resp.token,
            expiresAt: resp.expiresAt,
            user: me.user,
            permissions: me.permissions,
            dataScope: me.dataScope,
          }
          saveSession(next)
          setSession(next)
        } finally {
          setPendingToken(null)
        }
      },
      logout,
    }),
    [session, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
