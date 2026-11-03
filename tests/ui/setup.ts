import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { resetGlobalLocaleForTests, resetMockLoginState } from '@cadenza/ui'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetMockLoginState()
  resetGlobalLocaleForTests()
})
