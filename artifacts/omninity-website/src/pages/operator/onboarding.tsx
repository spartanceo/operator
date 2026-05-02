import { SetupWizard } from "@/components/onboarding/setup-wizard";
import type { OnboardingProfile } from "@workspace/api-client-react";

interface OnboardingPageProps {
  initialProfile: OnboardingProfile | null;
  onComplete: () => void;
}

export default function OnboardingPage({
  initialProfile,
  onComplete,
}: OnboardingPageProps) {
  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <SetupWizard initialProfile={initialProfile} onComplete={onComplete} />
    </div>
  );
}
