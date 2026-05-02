import { Switch, Route, Router as WouterRouter } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout/layout";
import LandingPage from "@/pages/landing";
import DownloadPage from "@/pages/download";
import PricingPage from "@/pages/pricing";
import MarketplacePage from "@/pages/marketplace";
import SkillDetailPage from "@/pages/skill-detail";
import CreatorsPage from "@/pages/creators";
import DocsPage from "@/pages/docs";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={LandingPage} />
        <Route path="/download" component={DownloadPage} />
        <Route path="/pricing" component={PricingPage} />
        <Route path="/marketplace" component={MarketplacePage} />
        <Route path="/marketplace/:slug" component={SkillDetailPage} />
        <Route path="/creators" component={CreatorsPage} />
        <Route path="/docs" component={DocsPage} />
        <Route path="/docs/:section" component={DocsPage} />
        <Route path="/docs/:section/:page" component={DocsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </TooltipProvider>
  );
}

export default App;
