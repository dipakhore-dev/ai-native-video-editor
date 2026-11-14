import { StudioProvider, useStudio } from "./context/StudioContext";
import { CreateProjectModal } from "./components/common/CreateProjectModal";
import { LandingPage } from "./pages/LandingPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EditorPage } from "./pages/EditorPage";
import { AiGeneratorPage } from "./pages/AiGeneratorPage";
import { MediaLibraryPage } from "./pages/MediaLibraryPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ExportsPage } from "./pages/ExportsPage";
import { AuthPage } from "./pages/AuthPage";
import { SettingsPage } from "./pages/SettingsPage";

function ActiveRouteView() {
  const { route } = useStudio();

  switch (route) {
    case "landing":
      return <LandingPage />;
    case "dashboard":
      return <DashboardPage />;
    case "editor":
      return <EditorPage />;
    case "generator":
      return <AiGeneratorPage />;
    case "media":
      return <MediaLibraryPage />;
    case "projects":
      return <ProjectsPage />;
    case "exports":
      return <ExportsPage />;
    case "auth":
      return <AuthPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <LandingPage />;
  }
}

export default function App() {
  return (
    <StudioProvider>
      <ActiveRouteView />
      <CreateProjectModal />
    </StudioProvider>
  );
}
