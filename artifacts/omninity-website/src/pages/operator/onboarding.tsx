import { LaunchSequence } from "@/components/onboarding/launch-sequence";

interface OnboardingPageProps {
  onComplete: () => void;
}

export default function OnboardingPage({ onComplete }: OnboardingPageProps) {
  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <LaunchSequence onComplete={onComplete} />
    </div>
  );
}
