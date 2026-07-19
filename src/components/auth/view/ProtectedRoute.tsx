import type { ReactNode } from 'react';
import { CHAT_LOGIN, IS_PLATFORM } from '../../../constants/config';
import { isNativeMobile } from '../../../mobile/serverConfig';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import AuthLoadingScreen from './AuthLoadingScreen';
import ChatLoginExperience from './ChatLoginExperience';
import LoginForm from './LoginForm';
import MobileLoginForm from './MobileLoginForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  // BTI chat-login owns its whole branch: logged-out → sign in through the chat;
  // signed-in → straight into the app (no Setup/Onboarding screens for customers).
  if (CHAT_LOGIN) {
    if (!user) {
      return <ChatLoginExperience />;
    }
    return <>{children}</>;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  // Native apps always start at the mobile login (which also picks the server),
  // even against a fresh server that would otherwise show the setup form.
  if (isNativeMobile() && !user) {
    return <MobileLoginForm />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
