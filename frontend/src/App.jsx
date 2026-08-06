import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import ChatPage from './pages/ChatPage'
import ProtectedRoute from './components/ProtectedRoute'
import { unlockAudioOnFirstInteraction } from './lib/ringtone'

function App() {
  // Unlock call ringtone audio on the very first click/keypress anywhere in the app —
  // long before any call happens — so it's not blocked by browser autoplay policy when
  // an incoming call's ringtone needs to play without a click of its own to unlock it.
  useEffect(() => {
    unlockAudioOnFirstInteraction()
  }, [])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default App
